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
  testMatch: ["/**/src/**/*.spec.(ts|js)"],
  testPathIgnorePatterns: ["/node_modules/", "/dist/"],
  testEnvironment: "node",
};
