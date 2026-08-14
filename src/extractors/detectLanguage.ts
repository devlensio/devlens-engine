// Detects the primary langauge of a repo by checking for the manifest files

import { Language } from "../index.js";
import fs from "fs";
import path from "path";

export function detectLanguage(repoPath: string): Language {
    // first for JS/TS, check for package.json first then use tsconfig.json to distinguish between JS and TS
    if(fs.existsSync(`${repoPath}/package.json`)) {
        if(fs.existsSync(`${repoPath}/tsconfig.json`)) {
            return "typescript";
        }
        return "javascript";
    }

    // secondly lets check for python.
    if(fs.existsSync(path.join(repoPath, "requirements.txt")) || 
        fs.existsSync(path.join(repoPath, "pyproject.toml")) || 
        fs.existsSync(path.join(repoPath, "setup.py"))) {
        return "python";
    }

    // Go
    if(fs.existsSync(path.join(repoPath, "go.mod"))){
        return "go";
    }

    // Rust
    if(fs.existsSync(path.join(repoPath, "Cargo.toml"))){
        return "rust";
    }

    // Java
    if(fs.existsSync(path.join(repoPath, "pom.xml")) ||
        fs.existsSync(path.join(repoPath, "build.gradle")) ||
        fs.existsSync(path.join(repoPath, "build.gradle.kts"))) {
        return "java";

    }

    return "unknown";
}
