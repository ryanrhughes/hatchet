import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface HatchetProject {
  name: string;
  path: string;
  remote?: string;
  description?: string;
}

interface ProjectsFile {
  projects: HatchetProject[];
}

function stripJsonComments(jsonc: string): string {
  return jsonc
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

export function projectsConfigPath(): string {
  return path.join(os.homedir(), ".config", "hatchet", "projects.jsonc");
}

function expandHome(inputPath: string): string {
  if (inputPath === "~") return os.homedir();
  if (inputPath.startsWith("~/")) return path.join(os.homedir(), inputPath.slice(2));
  return inputPath;
}

export function normalizeProjectPath(projectPath: string): string {
  return path.resolve(expandHome(projectPath));
}

export function loadProjects(): HatchetProject[] {
  const filePath = projectsConfigPath();
  if (!fs.existsSync(filePath)) return [];

  try {
    const parsed = JSON.parse(stripJsonComments(fs.readFileSync(filePath, "utf-8"))) as ProjectsFile;
    return (parsed.projects ?? []).map(project => ({
      ...project,
      path: normalizeProjectPath(project.path),
    })).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export function saveProjects(projects: HatchetProject[]): void {
  const filePath = projectsConfigPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const unique = new Map<string, HatchetProject>();
  for (const project of projects) {
    unique.set(project.name, { ...project, path: normalizeProjectPath(project.path) });
  }
  const data: ProjectsFile = { projects: [...unique.values()].sort((a, b) => a.name.localeCompare(b.name)) };
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

export function addProject(project: HatchetProject): HatchetProject {
  const normalized = { ...project, path: normalizeProjectPath(project.path) };
  const projects = loadProjects().filter(existing => existing.name !== normalized.name);
  projects.push(normalized);
  saveProjects(projects);
  return normalized;
}

export function findProject(name: string): HatchetProject | null {
  return loadProjects().find(project => project.name === name) ?? null;
}

export function inferProjectName(remoteOrPath: string): string {
  const cleaned = remoteOrPath.replace(/\.git$/, "");
  return path.basename(cleaned.replace(/[:/]$/, ""));
}

export function ensureProjectAvailable(project: HatchetProject): HatchetProject {
  const normalized = { ...project, path: normalizeProjectPath(project.path) };
  if (fs.existsSync(normalized.path)) return normalized;

  if (!normalized.remote) {
    throw new Error(`Project path does not exist and no remote is configured: ${normalized.path}`);
  }

  fs.mkdirSync(path.dirname(normalized.path), { recursive: true });
  execFileSync("git", ["clone", normalized.remote, normalized.path], {
    stdio: "inherit",
  });
  return normalized;
}
