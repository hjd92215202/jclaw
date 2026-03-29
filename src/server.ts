import path from "node:path";
import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? "7788");
const repoPath = process.env.REPO_PATH ? path.resolve(process.env.REPO_PATH) : process.cwd();

const app = createApp(repoPath);

app.listen(port, () => {
  console.log(`AI Workbench server is running on http://localhost:${port}`);
  console.log(`Repository root: ${repoPath}`);
});
