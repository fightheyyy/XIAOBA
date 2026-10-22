"""Runs inside the official task container, using its already installed MCP SDK."""
import asyncio
import base64
import json
import sys

from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client


async def main():
    request = json.loads(base64.b64decode(sys.argv[1]))
    async with streamablehttp_client(request["url"]) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            if request["op"] == "list":
                result = await session.list_tools()
                while result.nextCursor:
                    page = await session.list_tools(cursor=result.nextCursor)
                    result.tools.extend(page.tools)
                    result.nextCursor = page.nextCursor
            else:
                result = await session.call_tool(request["name"], request["args"])
            print(json.dumps(result.model_dump(mode="json", by_alias=True)))


if __name__ == "__main__":
    asyncio.run(main())
