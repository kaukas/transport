/** @type {import('prettier').Options} */
module.exports = {
  semi: true,
  trailingComma: 'all',
  singleQuote: true,
  printWidth: 120,
  tabWidth: 2,
  endOfLine: 'auto',
  plugins: ['prettier-plugin-sort-json', 'prettier-plugin-jsdoc'],
  jsdocCapitalizeDescription: false,
  jsonRecursiveSort: true,
  tsdoc: true,
};
