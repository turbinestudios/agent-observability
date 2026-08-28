/**
 * The renderer builds with `"types": []`, so Vite's own ambient declarations are
 * not in scope. Only the one import form the app actually uses is declared here.
 */
declare module '*.md?raw' {
  const content: string;
  export default content;
}
