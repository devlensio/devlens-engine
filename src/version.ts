import  packageJSON from "../package.json" with {type: "json"};

export const engineVersion : string = packageJSON.version;