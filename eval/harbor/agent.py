"""Harbor owns environments, stage setup, evidence collection and official scoring."""
import asyncio
import base64
import json
import os
from pathlib import Path
import shlex

from harbor.agents.base import BaseAgent
from harbor.agents.capabilities import AgentCapabilities
from harbor.models.trajectories.trajectory import Trajectory


class XiaobaAgent(BaseAgent):
    capabilities = AgentCapabilities(resume=True, mcp_servers=True, atif=True)

    @staticmethod
    def name():
        return "xiaobaos"

    def version(self):
        return "0.2.2"

    async def setup(self, environment):
        self.root = Path(__file__).resolve().parents[2]
        # Outside Harbor's per-step log sync/reset; persists beside result.json.
        self.evidence = self.logs_dir.parent / "xiaoba"
        self.evidence.mkdir(parents=True, exist_ok=True)
        self.index = 0
        self.process = None
        self.routes = {}
        self.stderr = None
        await environment.upload_file(Path(__file__).with_name("mcp_client.py"), "/tmp/xiaoba-mcp.py")

    async def _mcp(self, environment, request):
        encoded = base64.b64encode(json.dumps(request).encode()).decode()
        result = await environment.exec(
            "python /tmp/xiaoba-mcp.py " + shlex.quote(encoded), timeout_sec=120,
        )
        if result.return_code != 0:
            raise RuntimeError("Task MCP request failed: " + (result.stderr or ""))
        return json.loads(result.stdout)

    async def _send(self, message):
        self.process.stdin.write((json.dumps(message) + "\n").encode())
        await self.process.stdin.drain()

    async def _receive(self):
        line = await self.process.stdout.readline()
        if not line:
            raise RuntimeError("XiaoBa worker exited; see xiaoba/worker.stderr.log")
        message = json.loads(line)
        if message["type"] == "error":
            raise RuntimeError(message["error"])
        return message

    async def _start(self, environment):
        definitions = [{
            "name": "execute_shell",
            "description": "Execute a shell command in the task container /workspace. All files and simulated services are there; use shell commands for workspace files.",
            "parameters": {"type": "object", "properties": {
                "command": {"type": "string"},
            }, "required": ["command"]},
        }]
        for server in self.mcp_servers:
            if server.transport != "streamable-http":
                raise ValueError("P0 supports only VibeLifeBench streamable-http MCP servers")
            result = await self._mcp(environment, {"op": "list", "url": server.url})
            for tool in result["tools"]:
                name = server.name + "__" + tool["name"]
                self.routes[name] = (server.url, tool["name"])
                definitions.append({"name": name, "description": tool.get("description", ""),
                                    "parameters": tool["inputSchema"]})
        child_env = {**os.environ, **self.extra_env, "XIAOBA_APP_ROOT": str(self.root)}
        if self.model_name:
            child_env["XIAOBA_LLM_MODEL"] = self.model_name
        # Never activate a host Role or host Skills in the benchmark session.
        for key in ("XIAOBA_ROLE", "CURRENT_ROLE", "CURRENT_ROLE_DISPLAY_NAME", "XIAOBA_PROJECT_ROOT"):
            child_env.pop(key, None)
        self.stderr = (self.evidence / "worker.stderr.log").open("ab")
        self.process = await asyncio.create_subprocess_exec(
            "node", str(self.root / "dist/eval/harbor-session.js"),
            cwd=self.evidence, env=child_env, stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=self.stderr, limit=16 * 1024 * 1024,
        )
        await self._send({"type": "init", "tools": definitions})
        if (await self._receive())["type"] != "ready":
            raise RuntimeError("XiaoBa worker failed to initialize")

    async def _close(self):
        if self.process:
            self.process.stdin.close()
            try:
                await asyncio.wait_for(self.process.wait(), timeout=10)
            except asyncio.TimeoutError:
                self.process.kill()
                await self.process.wait()
        if self.stderr:
            self.stderr.close()

    def _publish_trajectory(self, instruction, message, actions):
        # Per-step ATIF keeps notifications as system input without the official
        # collector's last-user window accidentally including earlier stages.
        steps = [{"source": "system" if message["internal"] else "user", "message": instruction},
                 *actions, {"source": "agent", "message": message["text"]}]
        trajectory = Trajectory.model_validate({
            "schema_version": "ATIF-v1.7", "session_id": "harbor:task",
            "agent": {"name": self.name(), "version": self.version(), "model_name": self.model_name},
            "steps": [{"step_id": index + 1, **step} for index, step in enumerate(steps)],
        })
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        (self.logs_dir / "trajectory.json").write_text(trajectory.model_dump_json(exclude_none=True))

    async def run(self, instruction, environment, context):
        try:
            if not self.process:
                await self._start(environment)
            actions = []
            await self._send({"type": "stage", "index": self.index, "instruction": instruction})
            while True:
                message = await self._receive()
                if message["type"] == "done":
                    self._publish_trajectory(instruction, message, actions)
                    with (self.evidence / "responses.jsonl").open("a") as output:
                        output.write(json.dumps({"step": self.index, "text": message["text"]}) + "\n")
                    self.index += 1
                    context.metadata = {"xiaoba_evidence": str(self.evidence), "steps_completed": self.index}
                    return
                if message["type"] != "tool":
                    raise RuntimeError("Unexpected XiaoBa bridge message")
                try:
                    if message["name"] == "execute_shell":
                        result = await environment.exec(message["args"]["command"], cwd="/workspace", timeout_sec=120)
                        reply = {"toolContent": json.dumps({"stdout": result.stdout, "stderr": result.stderr,
                                                           "exit_code": result.return_code}),
                                 "status": "success" if result.return_code == 0 else "failure"}
                    else:
                        url, name = self.routes[message["name"]]
                        result = await self._mcp(environment, {"op": "call", "url": url, "name": name,
                                                               "args": message["args"]})
                        reply = {"toolContent": json.dumps(result),
                                 "status": "failure" if result.get("isError") else "success"}
                except Exception as error:
                    reply = {"toolContent": str(error), "status": "failure", "error_code": "HARBOR_TOOL_FAILED"}
                actions.append({"source": "agent", "message": "", "tool_calls": [{
                    "tool_call_id": message["call_id"], "function_name": message["name"],
                    "arguments": message["args"],
                }], "observation": {"results": [{
                    "source_call_id": message["call_id"],
                    "content": reply["toolContent"] if reply["status"] == "success" else
                               json.dumps({"isError": True, "content": reply["toolContent"]}),
                }]}})
                await self._send({"type": "tool_result", "id": message["id"], "result": reply})
        except BaseException:
            await self._close()
            raise

    async def resume(self, instruction, environment, context):
        if not self.process or self.process.returncode is not None:
            raise RuntimeError("XiaoBa live session lost; P0 does not reconstruct an interrupted trial")
        await self.run(instruction, environment, context)
