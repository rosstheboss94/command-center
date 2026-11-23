export function failure(code, message, context = {}) {
  return Object.assign(new Error(message), { code, ...context });
}
