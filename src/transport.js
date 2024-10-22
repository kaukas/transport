#!/usr/bin/env node

// @ts-check

import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { join, sep, dirname, relative } from 'path';
import realFsPromises from 'fs/promises';
import { homedir, tmpdir } from 'os';

/** @typedef {'pull' | 'push'} Operation */

/**
 * @param {string | undefined} argvOperation
 * @returns {Operation}
 */
function pickOperation(argvOperation) {
  if (argvOperation !== undefined) {
    const argvOperations = /** @type {const} */ ({ export: 'pull', import: 'push' });
    if (Object.prototype.hasOwnProperty.call(argvOperations, argvOperation)) {
      return argvOperations[/** @type {keyof typeof argvOperations} */ (argvOperation)];
    } else {
      throw new Error(`Unsupported operation ${argvOperation}`);
    }
  }
  const fzfOperations = /** @type {const} */ ({
    'Export Existing - list objects on your computer and download from Forgerock to your computer': 'pull',
    'Import Existing - upload objects from your computer to Forgerock': 'push',
    // 'Export New - list objects in Forgerock and download from Forgerock to your computer': 'pull',
    // 'Open the object in your browser': 'open',
  });
  const operationSelection = /** @type {keyof typeof fzfOperations} */ (
    execSync('fzf', { input: Object.keys(fzfOperations).join('\n'), encoding: 'utf8' }).trim()
  );
  return fzfOperations[operationSelection];
}

/** @param {string} tempfile */
function editScript(tempfile) {
  const editor = process.env.EDITOR || 'nano';
  execSync(`${editor} ${tempfile}`, { encoding: 'utf8', stdio: 'inherit' });
}

/** @param {string} tempfile */
function runScript(tempfile) {
  execSync(`bash ${tempfile}`, { encoding: 'utf8' });
}

/**
 * @param {string} rootDir
 * @param {typeof realFsPromises} fs
 * @param {string[]} argv
 * @returns {Promise<void>}
 */
export async function transport(rootDir, fs, argv) {
  /**
   * @param {string} tenant
   * @param {Operation} operation
   */
  function listSingletonObjects(tenant, operation) {
    switch (operation) {
      case 'pull':
      case 'push':
        return [
          { label: 'access-config', command: `npx ${operation} "${tenant}" access-config`, path: 'access-config' },
        ];
      default:
        throw new Error(`Unsupported operation: ${operation}`);
    }
  }

  /**
   * @param {string} tenant
   * @param {Operation} operation
   */
  async function listLocales(tenant, operation) {
    switch (operation) {
      case 'pull':
      case 'push':
        return (
          await Promise.all(
            (await fs.readdir(join(rootDir, 'locales'), { withFileTypes: true }))
              .filter((dirent) => dirent.isFile() && dirent.name.endsWith('.json'))
              .map((dirent) => fs.readFile(join(dirent.parentPath, dirent.name), 'utf8')),
          )
        )
          .map((content) => /** @type {string} */ (JSON.parse(content)._id.split('/')[1]))
          .map((locale) => ({
            label: `locale ${locale}`,
            command: `npx ${operation} "${tenant}" locales --name ${locale}`,
            path: `locales/${locale}.json`,
          }));
      default:
        throw new Error(`Unsupported operation: ${operation}`);
    }
  }

  /**
   * @param {string} tenant
   * @param {Operation} operation
   * @returns {Promise<{ label: string; command: string; path: string }[]>}
   */
  async function listObjects(tenant, operation) {
    return [...listSingletonObjects(tenant, operation), ...(await listLocales(tenant, operation))];
  }

  /** @param {string | undefined} argvTenant */
  async function pickTenant(argvTenant) {
    const tenantHostnames = Object.keys(
      JSON.parse(await fs.readFile(join(homedir(), '.frodo', 'Connections.json'), 'utf8')),
    ).map((url) => new URL(url).hostname);
    if (argvTenant === undefined) {
      return execSync('fzf', { input: tenantHostnames.sort().join('\n'), encoding: 'utf8' }).trim();
    } else {
      const matchingHostnames = tenantHostnames.filter((hostname) => hostname.includes(argvTenant));
      if (matchingHostnames.length === 1) {
        return matchingHostnames[0];
      } else if (matchingHostnames.length === 0) {
        throw new Error(`No tenants match ${argvTenant}`);
      } else {
        throw new Error(`Multiple tenants match ${argvTenant}: ${matchingHostnames.join(', ')}`);
      }
    }
  }

  /**
   * @param {string} tenant
   * @param {Operation} operation
   * @param {string[]} argvPaths
   */
  async function filesToObjects(tenant, operation, argvPaths) {
    argvPaths = argvPaths.map((argvPath) => relative(rootDir, argvPath));
    return (await listObjects(tenant, operation)).filter(({ path }) =>
      argvPaths.some((argvPath) => argvPath.startsWith(path)),
    );
  }

  /**
   * @param {string} tenant
   * @param {Operation} operation
   */
  async function pickObjects(tenant, operation) {
    const objects = await listObjects(tenant, operation);
    const chosenIndices = execSync(`fzf --with-nth 2.. --multi --header='You can select multiple objects with Tab'`, {
      input: objects.map((object, index) => `${index} ${object.label}`).join('\n'),
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .map((line) => line.split(' ')[0]);
    return chosenIndices.map((line) => objects[Number(line)]);
  }

  /**
   * @param {string} tempfile
   * @param {{ command: string }[]} objects
   * @returns {Promise<void>}
   */
  function createScript(tempfile, objects) {
    const scriptLines = objects.map(({ command }) => command);
    const script = `#!/bin/bash

# Adjust the commands below as needed and save this file. Once closed this file will get executed as a bash script.
# If you want nothing executed then remove all commands, save, and close this file.

# Print each command before execution
set -x

${scriptLines.join('\n')}
`;
    return fs.writeFile(tempfile, script);
  }

  /**
   * https://advancedweb.hu/secure-tempfiles-in-nodejs-without-dependencies/
   *
   * @param {{ (tempfile: any): Promise<void>; (arg0: string): any }} callback
   */
  function withTempFile(callback) {
    return withTempDir((/** @type {string} */ dir) => callback(join(dir, 'file')));
  }

  /** @param {{ (dir: string): Promise<void> }} callback */
  async function withTempDir(callback) {
    const dir = await fs.mkdtemp((await fs.realpath(tmpdir())) + sep);
    try {
      return await callback(dir);
    } finally {
      fs.rm(dir, { recursive: true });
    }
  }

  const tenant = await pickTenant(argv.shift());
  const operation = pickOperation(argv.shift());
  const objects = argv.length ? await filesToObjects(tenant, operation, argv) : await pickObjects(tenant, operation);

  await withTempFile(async (/** @type {string} */ tempfile) => {
    await createScript(tempfile, objects);
    if (!argv.length) {
      editScript(tempfile);
    }
    runScript(tempfile);
  });
}

// @ts-ignore
const url = import.meta.url;
if (url === `file://${process.argv[1]}`) {
  const rootDir = dirname(dirname(fileURLToPath(url)));
  transport(rootDir, realFsPromises, process.argv.slice(2));
}
