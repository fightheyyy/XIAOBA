"""Scripted transport test, never benchmark score evidence. Requires npm run build."""
import asyncio
import base64
import json
import shutil
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "eval/harbor"))
from agent import XiaobaAgent
from harbor.models.agent.context import AgentContext
from harbor.models.task.config import MCPServerConfig
from harbor.models.trajectories.trajectory import Trajectory


class TaskEnvironment:
    def __init__(self, root):
        self.root = root

    async def upload_file(self, source, target):
        assert Path(source).is_file()
        assert target == "/tmp/xiaoba-mcp.py"

    async def exec(self, command, **kwargs):
        if command.startswith("python /tmp/xiaoba-mcp.py "):
            request = json.loads(base64.b64decode(command.split()[-1]))
            if request["op"] == "list":
                value = {"tools": [{"name": "write", "description": "mock service write",
                                    "inputSchema": {"type": "object", "properties": {}}}]}
            else:
                # Emulate a task service side effect, independent of assistant prose.
                (self.root / "service.json").write_text(json.dumps(request))
                value = {"content": [{"type": "text", "text": "receipt-42"}], "isError": False}
            return SimpleNamespace(return_code=0, stdout=json.dumps(value), stderr="")
        child = await asyncio.create_subprocess_shell(command, cwd=self.root,
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        stdout, stderr = await child.communicate()
        return SimpleNamespace(return_code=child.returncode, stdout=stdout.decode(), stderr=stderr.decode())


class HarborBridgeTest(unittest.IsolatedAsyncioTestCase):
    async def test_real_worker_across_run_and_resume_with_remote_shell_and_mcp(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            preload = root / "scripted-model.cjs"
            preload.write_text(
                "const {AIService}=require(" + json.dumps(str(ROOT / "dist/utils/ai-service.js")) + ");\n"
                "let stages=0; AIService.prototype.chatStream=async function(messages) {\n"
                "if(messages.at(-1).role==='tool') return {content:'done'};\n"
                "const name=++stages===1?'execute_shell':'notion__write';\n"
                "return {toolCalls:[{id:'tool-'+stages,type:'function',function:{name,\n"
                "arguments:JSON.stringify(name==='execute_shell'?{command:'printf bridge-ok > marker.txt'}:{})}}]};\n"
                "};\n"
            )
            agent = XiaobaAgent(logs_dir=root / "agent", extra_env={
                "XIAOBA_LLM_PROVIDER": "openai", "XIAOBA_LLM_MODEL": "scripted-transport-test",
                "XIAOBA_LLM_API_KEY": "not-a-live-key", "NODE_OPTIONS": "--require=" + str(preload),
            }, mcp_servers=[MCPServerConfig(name="notion", transport="streamable-http", url="http://notion:8000/mcp")])
            environment = TaskEnvironment(root)
            await agent.setup(environment)
            try:
                await agent.run('[2026-05-20 09:00 +08:00] User Wang Fang says:\n\nStart.', environment, AgentContext())
                pid = agent.process.pid
                context = AgentContext()
                await agent.resume('[2026-05-21 09:00 +08:00] Notice from the Court:\n\nUpdated.', environment, context)
                self.assertEqual(agent.process.pid, pid)
                self.assertEqual((root / "marker.txt").read_text(), "bridge-ok")
                self.assertEqual(json.loads((root / "service.json").read_text())["name"], "write")
                self.assertEqual(context.metadata["steps_completed"], 2)
                trajectory = Trajectory.model_validate_json((agent.logs_dir / "trajectory.json").read_text())
                self.assertEqual(trajectory.steps[0].source, "system")
                self.assertEqual(trajectory.steps[1].tool_calls[0].function_name, "notion__write")
                self.assertNotIn("execute_shell", trajectory.model_dump_json())
                traces = list((agent.evidence / "logs").rglob("traces.jsonl"))
                self.assertEqual(len(traces), 1)
                rows = [json.loads(line) for line in traces[0].read_text().splitlines()]
                self.assertEqual(len([row for row in rows if row.get("entry_type") == "trace"]), 2)
                self.assertIn("receipt-42", json.dumps(rows))
                self.assertEqual(len(list((agent.evidence / "data/events").glob("*.json"))), 2)
            finally:
                await agent._close()
                shutil.copytree(agent.evidence, ROOT / "output/test/harbor-bridge" / root.name, dirs_exist_ok=True)
                shutil.copy2(agent.logs_dir / "trajectory.json", ROOT / "output/test/harbor-bridge" / root.name)
            self.assertIsNotNone(agent.process.returncode)


if __name__ == "__main__":
    unittest.main()
