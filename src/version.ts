/**
 * CodeLens version string — single source of truth for the running build's version.
 * Kept in step with package.json manually until the build injects it. Also serves as
 * the first buildable+testable module so the CI toolchain (CL-19) has something real
 * to compile and cover before the pipeline modules (CL-3+) land.
 */
export const VERSION = "0.1.0";
