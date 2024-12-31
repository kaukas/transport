#!/usr/bin/env node

// @ts-check

import { fileURLToPath } from 'url';
import { ChildProcess, exec, execSync } from 'child_process';
import { join, dirname, relative } from 'path';
import { homedir } from 'os';
import { readFile, readdir } from 'fs/promises';
import idmFlatConfig from '@forgerock/fr-config-manager/packages/fr-config-pull/src/scripts/idmFlatConfig.js';
import locales from '@forgerock/fr-config-manager/packages/fr-config-pull/src/scripts/locales.js';
import { restPut } from '@forgerock/fr-config-manager/packages/fr-config-common/src/restClient.js';
import { getToken } from '@forgerock/fr-config-manager/packages/fr-config-common/src/authenticate.js';
/** @type {import('axios').default} */
import axios from '../node_modules/axios/dist/node/axios.cjs' ;

/**
 * Catch file or directory missing and return an empty replacement.
 *
 * @template ObjType
 * @param {ObjType} emptyObj
 * @param {() => Promise<ObjType>} callback
 */
async function handleNoEnt(emptyObj, callback) {
  try {
    return await callback();
  } catch (e) {
    if (e.code === 'ENOENT') {
      return emptyObj;
    }
    throw e;
  }
}

/** @typedef {'pull' | 'push'} Operation */
/**
 * @typedef {{
 *   label: string;
 *   run: (token: string) => any;
 *   path: string;
 * }} FrObject
 */

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
    'Export - download objects from Forgerock to your computer': 'pull',
    'Import - upload objects from your computer to Forgerock': 'push',
    // 'Open the object in your browser': 'open',
  });
  const operationSelection = /** @type {keyof typeof fzfOperations} */ (
    execSync('fzf', { input: Object.keys(fzfOperations).join('\n'), encoding: 'utf8' }).trim()
  );
  return fzfOperations[operationSelection];
}

// /** @param {string} tempfile */
// function editScript(tempfile) {
//   const editor = process.env.EDITOR || 'nano';
//   execSync(`${editor} ${tempfile}`, { encoding: 'utf8', stdio: 'inherit' });
// }
//
// /** @param {string} tempfile */
// function runScript(tempfile) {
//   execSync(`bash ${tempfile}`, { encoding: 'utf8' });
// }

/**
 * @template T
 * @param {() => T} callback
 * @returns {T}
 */
function withAxiosInterceptors(callback) {
  let alive = true;
  /** @type {AbortController[]} */
  const abortControllers = [];
  /** @type {number} */
  const abortInterceptor = axios.interceptors.request.use((config) => {
    if (alive) {
      const controller = new AbortController();
      config.signal = controller.signal;
      abortControllers.push(controller);
      return config;
    } else {
      throw new Error('Aborted');
    }
  });

  try {
    return callback();
  } finally {
    alive = false;
    axios.interceptors.request.eject(abortInterceptor);
    abortControllers.forEach((controller) => controller.abort());
  }
}

/**
 * @param {string} rootDir
 * @param {string[]} argv
 * @returns {Promise<void>}
 */
export async function transport(rootDir, argv) {
  const connectionsPromise = readFile(join(homedir(), '.config', 'transport', 'connections.json'), 'utf8').then(
    (content) => JSON.parse(content),
  );

  /**
   * @param {string} tenant
   * @param {any} connection
   * @returns {Promise<string>}
   */
  async function acquireToken(tenant, connection) {
    return getToken(tenant, {
      clientId: connection.clientId,
      scope: connection.scope,
      jwtIssuer: connection.serviceAccountId,
      privateKey: connection.serviceAccountKey,
    });
  }

  /**
   * @param {string} tenant
   * @param {Operation} operation
   * @returns {AsyncGenerator<FrObject>}
   */
  async function* listSingletonObjects(tenant, operation) {
    switch (operation) {
      case 'pull':
        yield {
          label: 'access-config',
          run: (token) => idmFlatConfig.exportConfig('access', rootDir, 'access-config', tenant, token),
          path: 'access-config',
        };
        return;
      case 'push': {
        const accessConfigContent = await handleNoEnt(null, async () =>
          JSON.parse(await readFile(join(rootDir, 'access-config', 'access.json'), 'utf8')),
        );
        if (accessConfigContent) {
          yield {
            label: 'access-config',
            run: (token) => restPut(new URL('/openidm/config/access', tenant).toString(), accessConfigContent, token),
            path: 'access-config',
          };
        }
        return;
      }
      default:
        throw new Error(`Unsupported operation: ${operation}`);
    }
  }

  /**
   * @param {string} tenant
   * @param {Operation} operation
   * @returns {AsyncGenerator<FrObject>}
   */
  async function* listLocales(tenant, operation) {
    switch (operation) {
      case 'pull':
        //   case 'push':
        yield* (
          await Promise.all(
            (await readdir(join(rootDir, 'locales'), { withFileTypes: true }))
              .filter((dirent) => dirent.isFile() && dirent.name.endsWith('.json'))
              .map((dirent) => readFile(join(dirent.parentPath, dirent.name), 'utf8')),
          )
        )
          .map((content) => /** @type {string} */ (JSON.parse(content)._id.split('/')[1]))
          .map((localeName) => ({
            label: `locale ${localeName}`,
            run: (/** @type {string} */ token) => locales.exportLocales(rootDir, tenant, localeName, token),
            path: `locales/${localeName}.json`,
          }));
        return;
      default:
        throw new Error(`Unsupported operation: ${operation}`);
    }
  }

  /**
   * @param {string} tenant
   * @param {Operation} operation
   * @returns {AsyncGenerator<FrObject>}
   */
  async function* listObjects(tenant, operation) {
    yield* listSingletonObjects(tenant, operation);
    yield* listLocales(tenant, operation);
  }

  /**
   * @param {string | undefined} argvTenant
   * @returns {Promise<[string, any]>}
   */
  async function pickTenant(argvTenant) {
    const connections = await connectionsPromise;
    const tenantOrigins = Object.keys(connections).map((url) => new URL(url).origin);
    /** @type {string} */
    let tenant;
    if (argvTenant === undefined) {
      tenant = execSync('fzf', { input: tenantOrigins.sort().join('\n'), encoding: 'utf8' }).trim();
    } else {
      const matchingOrigins = tenantOrigins.filter((origin) => origin.includes(argvTenant));
      if (matchingOrigins.length === 1) {
        tenant = matchingOrigins[0];
      } else if (matchingOrigins.length === 0) {
        throw new Error(`No tenants match ${argvTenant}`);
      } else {
        throw new Error(`Multiple tenants match ${argvTenant}: ${matchingOrigins.join(', ')}`);
      }
    }
    return [tenant, connections[tenant]];
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
    const objects = listObjects(tenant, operation);
    //////** @type {ChildProcess} */
    // let proc;
    // const chosenIndices = new Promise((resolve, reject) => {
    const proc = exec(
      `fzf --with-nth 2.. --multi --header='You can select multiple objects with Tab'`,
      // {},
      // (err, stdout) => {
      //   // return (err ? reject(err) : resolve(stdout));
      // },
    );
    console.log(111, proc);
    for await (const object of objects) {
      // if (objectsFinished) {
      //   break;
      // }
      proc.stdin.write(`${object.label}\n`);
    }
    // });

    // let objectsFinished = false;
    // chosenIndices.finally(() => {
    //   objectsFinished = true;
    // });

    // stdin: objects.map((object, index) => `${index} ${object.label}`).join('\n'),
    // const chosenIndices =
    //   .trim()
    //   .split('\n')
    //   .map((line) => line.split(' ')[0]);
    return (await chosenIndices).map((line) => objects[Number(line)]);
  }

  //   /**
  //    * @param {string} tempfile
  //    * @param {{ command: string }[]} objects
  //    * @returns {Promise<void>}
  //    */
  //   function createScript(tempfile, objects) {
  //     const scriptLines = objects.map(({ command }) => command);
  //     const script = `#!/bin/bash
  //
  // # Adjust the commands below as needed and save this file. Once closed this file will get executed as a bash script.
  // # If you want nothing executed then remove all commands, save, and close this file.
  //
  // # Print each command before execution
  // set -x
  //
  // ${scriptLines.join('\n')}
  // `;
  //     return writeFile(tempfile, script);
  //   }

  // /**
  //  * https://advancedweb.hu/secure-tempfiles-in-nodejs-without-dependencies/
  //  *
  //  * @param {{ (tempfile: any): Promise<void>; (arg0: string): any }} callback
  //  */
  // function withTempFile(callback) {
  //   return withTempDir((/** @type {string} */ dir) => callback(join(dir, 'file')));
  // }

  // /** @param {{ (dir: string): Promise<void> }} callback */
  // async function withTempDir(callback) {
  //   const dir = await mkdtemp((await realpath(tmpdir())) + sep);
  //   try {
  //     return await callback(dir);
  //   } finally {
  //     rm(dir, { recursive: true });
  //   }
  // }

  return withAxiosInterceptors(async () => {
    const [tenant, connection] = await pickTenant(argv.shift());
    const operation = pickOperation(argv.shift());
    const tokenPromise = acquireToken(tenant, connection);
    const objects = argv.length ? await filesToObjects(tenant, operation, argv) : await pickObjects(tenant, operation);

    return Promise.all(objects.map(async ({ run }) => run(await tokenPromise)));
  });

  // } finally {
  //   await firstRequestPromise;
  //   axios.interceptors.request.eject(abortInterceptor);
  //   console.log(abortControllers);
  //   abortControllers.forEach((controller) => controller.abort());
  // }
}

// module.exports.transport = transport;

const url = import.meta.url;
if (url === `file://${process.argv[1]}`) {
  const rootDir = dirname(dirname(fileURLToPath(url)));
  transport(rootDir, process.argv.slice(2));
}
// if (require.main === module) {
//   const rootDir = dirname(dirname(__filename));
//   transport(rootDir, process.argv.slice(2));
// }
