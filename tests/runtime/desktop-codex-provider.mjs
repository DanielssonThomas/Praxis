import assert from "node:assert/strict";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { runtimeOutputLimit } from "@praxis/contracts";

const frame = (event) => "data: " + JSON.stringify(event) + "\n\n";
const editCall = "edit-packaged-fixture";
const padding = "Bounded earlier text from the disposable Codex worker.\n".repeat(320);
export const scriptedUsage = { input: 11, output: 5 };

export async function startPackagedCodexProvider(t, { brief, file, initial, delivered, marker, profileRoot }) {
  const emitted = padding + marker;
  const finish = Promise.withResolvers();
  let launches = 0;
  let failure;
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/responses");
      assert.equal(request.headers.authorization, undefined);
      const chunks = [];
      for await (const bytes of request) chunks.push(bytes);
      const body = JSON.parse(Buffer.concat(chunks));
      const outcome = body.input.find(({ type, call_id }) => type === "custom_tool_call_output" && call_id === editCall);
      const id = outcome ? "response-native-output" : "response-native-edit";
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(frame({ type: "response.created", response: { id } }));
      if (outcome) {
        assert.ok(JSON.stringify(outcome.output).includes(marker), "The native Code Mode edit did not return its marker.");
        const item = { id: "message-packaged-codex", type: "message", role: "assistant", status: "completed",
          content: [{ type: "output_text", text: emitted, annotations: [] }],
        };
        response.write(frame({ type: "response.output_item.added", item: { ...item, content: [], status: "in_progress" } }));
        response.write(frame({ type: "response.output_text.delta", delta: emitted, item_id: item.id, output_index: 0, content_index: 0 }));
        response.write(frame({ type: "response.output_item.done", item }));
        await finish.promise;
      } else {
        launches++;
        assert.equal(launches, 1, "The Codex provider received an unexpected second assignment.");
        const user = body.input.filter(({ type, role }) => type === "message" && role === "user")
          .flatMap(({ content }) => content).map(({ text }) => text);
        assert.ok(user.some((text) => text.includes("Axiom policy digest: " + brief.policy.digest)));
        const prompt = user.at(-1);
        assert.deepEqual(JSON.parse(prompt.slice(prompt.indexOf("\n") + 1)), brief);
        assert.ok(body.tools.some(({ name }) => name === "exec"), "The worker did not expose native Code Mode.");
        const read = "cat -- " + file;
        const edit = "printf '%s\\n' " + JSON.stringify(delivered.trimEnd()) + " > " + file;
        const input = [
          "const before = await tools.exec_command({cmd:" + JSON.stringify(read) + "});",
          "if (before.exit_code !== 0 || before.output.trim() !== " + JSON.stringify(initial.trim()) + ") throw new Error('Exact staged source missing.');",
          "const result = await tools.exec_command({cmd:" + JSON.stringify(edit) + "});",
          "if (result.exit_code !== 0) throw new Error('Scoped edit failed.');",
          "text(" + JSON.stringify(marker) + ");",
        ].join("\n");
        response.write(frame({ type: "response.output_item.done",
          item: { type: "custom_tool_call", call_id: editCall, name: "exec", input },
        }));
      }
      const input = outcome ? scriptedUsage.input : 0;
      const output = outcome ? scriptedUsage.output : 0;
      response.end(frame({ type: "response.completed", response: { id, status: "completed",
        usage: { input_tokens: input, output_tokens: output, total_tokens: input + output },
      } }));
    } catch (error) {
      failure = error;
      response.end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    finish.resolve();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  await writeFile(join(profileRoot, "config.toml"), [
    'model_provider = "fixture"', "[features]", "code_mode_only = true",
    "[code_mode]", "disable_in_process_fallback = true",
    "[model_providers.fixture]", 'name = "Disposable packaged fixture"',
    'base_url = "http://127.0.0.1:' + server.address().port + '/v1"', 'wire_api = "responses"',
    "requires_openai_auth = false", "request_max_retries = 0", "stream_max_retries = 0",
  ].join("\n"), { mode: 0o600 });
  return {
    truncatedOutput: emitted.slice(-runtimeOutputLimit),
    finish: finish.resolve,
    assertLaunches(expected) {
      if (failure) throw failure;
      assert.equal(launches, expected, "Unexpected number of native Codex launches.");
    },
  };
}
