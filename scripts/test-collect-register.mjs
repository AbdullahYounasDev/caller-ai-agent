// `node --import ./scripts/test-collect-register.mjs scripts/test-collect.mjs`
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";

register("./alias-loader.mjs", import.meta.url, {
  data: { stubLlm: pathToFileURL(path.resolve("scripts/test-collect-stub.mjs")).href },
});
