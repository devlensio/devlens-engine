import os   from "os";
import path from "path";

export const CONFIG_DIR  = path.join(os.homedir(), ".devlens");
export const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
