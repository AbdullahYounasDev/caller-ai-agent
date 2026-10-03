// `node --import ./scripts/test-reembed-register.mjs scripts/test-reembed.mjs`
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";

register("./alias-loader.mjs", import.meta.url, {
  data: { stubLlm: pathToFileURL(path.resolve("scripts/test-reembed-stub.mjs")).href },
});
