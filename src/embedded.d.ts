// The built screens are embedded as text (see server.ts).
declare module "*/dist/ui/app.js" { const text: string; export default text; }
declare module "*/dist/ui/style.css" { const text: string; export default text; }
declare module "*.md" { const text: string; export default text; }
declare module "*.png" { const path: string; export default path; }
