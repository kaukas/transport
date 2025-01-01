#!/usr/bin/env node

// @ts-check

const { execSync: execSyncReal, spawn: spawnReal } = require('child_process');
const { join, dirname, relative } = require('path');
const { homedir } = require('os');
const { readFile } = require('fs/promises');
const { readFileSync, readdirSync } = require('fs');
const idmFlatConfig = require('@forgerock/fr-config-manager/packages/fr-config-pull/src/scripts/idmFlatConfig.js');
const locales = require('@forgerock/fr-config-manager/packages/fr-config-pull/src/scripts/locales.js');
const { restPut } = require('@forgerock/fr-config-manager/packages/fr-config-common/src/restClient.js');
const { getToken } = require('@forgerock/fr-config-manager/packages/fr-config-common/src/authenticate.js');
const axios = require('axios');

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
 * @param {typeof execSyncReal} execSync
 * @param {typeof spawnReal} spawn
 * @param {string[]} argv
 * @returns {Promise<void>}
 */
async function transport(rootDir, execSync, spawn, argv) {
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
          // FIXME: readFile throws "ENXIO: no such device or address, read"
          JSON.parse(readFileSync(join(rootDir, 'access-config', 'access.json'), 'utf8')),
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
    const localLocaleContents = (
      await handleNoEnt([], async () => readdirSync(join(rootDir, 'locales'), { withFileTypes: true }))
    )
      .filter((dirent) => dirent.isFile() && dirent.name.endsWith('.json'))
      .map((dirent) => readFileSync(join(dirent.parentPath, dirent.name), 'utf8'))
      .map((content) => JSON.parse(content));
    switch (operation) {
      case 'pull':
        yield* localLocaleContents
          .map((content) => /** @type {string} */ (content._id.split('/')[1]))
          .map(
            (localeName) =>
              /** @type {FrObject} */ ({
                label: `locale ${localeName}`,
                run: (token) => locales.exportLocales(rootDir, tenant, localeName, token),
                path: `locales/${localeName}.json`,
              }),
          );
        return;
      case 'push':
        yield* localLocaleContents
          .map((content) => /** @type {[string, string, any]} */ ([content._id.split('/')[1], content._id, content]))
          .map(
            ([localeName, localeId, content]) =>
              /** @type {FrObject} */ ({
                label: `locale ${localeName}`,
                run: (token) => restPut(new URL(`/openidm/config/${localeId}`, tenant).toString(), content, token),
                path: `locales/${localeName}.json`,
              }),
          );
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
    return listObjects(tenant, operation).filter(({ path }) => argvPaths.some((argvPath) => argvPath.startsWith(path)));
  }

  /**
   * @param {string} tenant
   * @param {Operation} operation
   */
  async function pickObjects(tenant, operation) {
    const objects = listObjects(tenant, operation);
    const objectsCache = [];
    const cproc = spawn('fzf', [
      '--with-nth',
      '2..',
      '--multi',
      '--header',
      'You can select multiple objects with Tab',
    ]);

    const chosenIndices = new Promise((resolve, reject) => {
      let output = '';
      cproc.stdout.on('data', (data) => {
        output += data.toString();
      });
      cproc.on('close', () => {
        resolve(output.trim().split('\n'));
      });
      cproc.on('error', reject);

      (async () => {
        for await (const object of objects) {
          objectsCache.push(object);
          // if (objectsFinished) {
          //   break;
          // }
          cproc.stdin.write(`${objectsCache.length - 1} ${object.label}\n`);
        }
        cproc.stdin.end();
      })();
    });
    return /** @type {string[]} */ (await chosenIndices).map((line) => objectsCache[parseInt(line)]).filter((i) => i);
  }

  await withAxiosInterceptors(async () => {
    const [tenant, connection] = await pickTenant(argv.shift());
    const operation = pickOperation(argv.shift());
    const tokenPromise = acquireToken(tenant, connection);
    const objects = argv.length ? await filesToObjects(tenant, operation, argv) : await pickObjects(tenant, operation);

    return Promise.all(objects.map(async ({ run }) => run(await tokenPromise)));
  });
  return connectionsPromise;

  // } finally {
  //   await firstRequestPromise;
  //   axios.interceptors.request.eject(abortInterceptor);
  //   console.log(abortControllers);
  //   abortControllers.forEach((controller) => controller.abort());
  // }
}

module.exports.transport = transport;

// const url = import.meta.url;
// if (url === `file://${process.argv[1]}`) {
//   const rootDir = dirname(dirname(fileURLToPath(url)));
//   transport(rootDir, process.argv.slice(2));
// }
if (require.main === module) {
  const rootDir = dirname(dirname(__filename));
  transport(rootDir, execSyncReal, spawnReal, process.argv.slice(2));
}
