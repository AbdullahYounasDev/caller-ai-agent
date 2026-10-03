// `node --import ./scripts/alias-register.mjs <script>` — see alias-loader.mjs.
import { register } from "node:module";

register("./alias-loader.mjs", import.meta.url);
