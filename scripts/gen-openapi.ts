// Regenerates contract/openapi.json from the zod source of truth.
//   npm run contract:gen
// The openapi.test.ts "up to date" check fails CI if you edit a schema without
// rerunning this. The real logic lives in src/contract/openapi.ts (typechecked).
import { writeOpenApiArtifact } from "../src/contract/openapi";

const path = writeOpenApiArtifact();
console.log(`contract: wrote ${path}`);
