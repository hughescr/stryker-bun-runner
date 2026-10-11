/**
 * Remember process.env as it is now. The returned function puts it back: keys
 * added since are deleted, changed or removed keys get their old values. It
 * edits process.env in place, never replacing the object (assigning a plain
 * object to process.env detaches it from the real environment that child
 * processes inherit).
 *
 * Take it in the beforeEach (or beforeAll) of the test (or file) that changes
 * the environment and call it in the matching afterEach (or afterAll).
 */
export function rememberEnv(): () => void {
    const saved = { ...process.env };
    return () => {
        for(const key of Object.keys(process.env)) {
            if(!Object.hasOwn(saved, key)) {
                Reflect.deleteProperty(process.env, key);
            }
        }
        for(const [key, value] of Object.entries(saved)) {
            if(process.env[key] !== value) {
                process.env[key] = value;
            }
        }
    };
}
