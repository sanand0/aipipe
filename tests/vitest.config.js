import config from "../vitest.config.js";

export default {
  ...config,
  test: { ...config.test, include: ["cf-tests/**/*.test.js"] },
};
