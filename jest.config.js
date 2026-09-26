module.exports = {
  moduleFileExtensions: ["ts", "js"],
  transform: {
    "^.+\\.(ts|tsx)$": [
      "@swc/jest",
      {
        jsc: {
          target: "es2019",
        },
      },
    ],
  },
  coverageProvider: "v8",
  coverageThreshold: {
    global: {
      branches: 90,
      functions: 95,
      lines: 95,
      statements: 95,
    },
  },
  testMatch: ["/**/src/**/*.spec.(ts|js)"],
  testPathIgnorePatterns: ["/node_modules/", "/dist/"],
  testEnvironment: "node",
};
