#!/usr/bin/env node

// @ts-check

const { execSync: execSyncReal, spawn: spawnReal } = require('child_process');
const { join, dirname, relative, basename } = require('path');
const { homedir } = require('os');
const { readFile } = require('fs/promises');
const { glob } = require('glob');
const { readFileSync } = require('fs');
const axios = require('axios');

const { getToken } = require('@forgerock/fr-config-manager/packages/fr-config-common/src/authenticate.js');
const { restGet } = require('@forgerock/fr-config-manager/packages/fr-config-common/src/restClient.js');
const {
  exportEmailTemplates,
} = require('@forgerock/fr-config-manager/packages/fr-config-pull/src/scripts/emailTemplates.js');
const { exportConfig } = require('@forgerock/fr-config-manager/packages/fr-config-pull/src/scripts/idmFlatConfig.js');
const { exportJourneys } = require('@forgerock/fr-config-manager/packages/fr-config-pull/src/scripts/journeys.js');
const { exportLocales } = require('@forgerock/fr-config-manager/packages/fr-config-pull/src/scripts/locales.js');
const {
  updateAuthTrees,
  updateEmailTemplates,
  updateIdmAccessConfig,
  updateLocales,
} = require('@forgerock/fr-config-manager/packages/fr-config-push/src/scripts');

// /**
//  * Catch file or directory missing and return an empty replacement.
//  *
//  * @template ObjType
//  * @param {ObjType} emptyObj
//  * @param {() => Promise<ObjType>} callback
//  */
// async function handleNoEnt(emptyObj, callback) {
//   try {
//     return await callback();
//   } catch (e) {
//     if (e.code === 'ENOENT') {
//       return emptyObj;
//     }
//     throw e;
//   }
// }

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
   * @template T
   * @param {string} tenant
   * @param {{ (): Promise<T> }} callback
   * @returns T
   */
  function withFCMEnv(tenant, callback) {
    const originalConsoleLog = console.log;
    try {
      console.log = () => {};
      process.env.CONFIG_DIR = rootDir;
      process.env.TENANT_BASE_URL = tenant;
      return callback();
    } finally {
      delete process.env.CONFIG_DIR;
      delete process.env.TENANT_BASE_URL;
      console.log = originalConsoleLog;
    }
  }

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

  const connectionsPromise = readFile(join(homedir(), '.config', 'forgerock', 'connections.json'), 'utf8').then(
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
          run: (token) => exportConfig('access', rootDir, 'access-config', tenant, token),
          path: 'access-config',
        };
        return;
      case 'push': {
        const matchingPaths = await glob(join(rootDir, 'access-config', 'access.json'));
        if (matchingPaths.length) {
          yield {
            label: 'access-config',
            run: (token) => withFCMEnv(tenant, () => updateIdmAccessConfig({}, token)),
            path: 'access-config',
          };
        }
        return;
      }
    }
  }

  /**
   * @param {string} tenant
   * @param {Operation} operation
   * @param {{ openidmConfigNames: Promise<string[]> } | undefined} cachedQueries
   * @returns {AsyncGenerator<FrObject>}
   */
  async function* listLocales(tenant, operation, cachedQueries) {
    const idToName = (/** @type {string} */ id) => id.split('/')[1];
    const forName = (/** @type {string} */ name) => ({ label: `locale ${name}`, path: `locales/${name}.json` });
    const localLocaleNames = (await glob(join(rootDir, 'locales', '*.json')))
      .map((filePath) => JSON.parse(readFileSync(filePath, 'utf8')))
      .map((content) => idToName(content._id));
    switch (operation) {
      case 'pull': {
        const pull = (/** @type {string} */ name) =>
          /** @type {FrObject} */ ({ ...forName(name), run: (token) => exportLocales(rootDir, tenant, name, token) });
        yield* localLocaleNames.map(pull);
        yield* ((await cachedQueries.openidmConfigNames) ?? [])
          .filter((id) => id.startsWith('uilocale/'))
          .map(idToName)
          .filter((name) => !localLocaleNames.includes(name))
          .map(pull);
        return;
      }
      case 'push':
        yield* localLocaleNames.map(
          (name) =>
            /** @type {FrObject} */ ({
              ...forName(name),
              run: (token) => withFCMEnv(tenant, () => updateLocales({ name }, token)),
            }),
        );
        return;
    }
  }

  /**
   * @param {string} tenant
   * @param {Operation} operation
   * @param {{ openidmConfigNames: Promise<string[]> } | undefined} cachedQueries
   * @returns {AsyncGenerator<FrObject>}
   */
  async function* listEmailTemplates(tenant, operation, cachedQueries) {
    const idToName = (/** @type {string} */ id) => id.split('/')[1];
    const forName = (/** @type {string} */ name) => ({ label: `email ${name}`, path: `email-templates/${name}.json` });
    const localEmailNames = (await glob(join(rootDir, 'email-templates', '**', '*.json')))
      .map((filePath) => JSON.parse(readFileSync(filePath, 'utf8')))
      .map((content) => idToName(content._id));
    switch (operation) {
      case 'pull': {
        const pull = (/** @type {string} */ name) =>
          /** @type {FrObject} */ ({
            ...forName(name),
            run: (token) => exportEmailTemplates(rootDir, tenant, name, token),
          });
        yield* localEmailNames.map(pull);
        yield* ((await cachedQueries.openidmConfigNames) ?? [])
          .filter((id) => id.startsWith('emailTemplate/'))
          .map(idToName)
          .filter((emailName) => !localEmailNames.includes(emailName))
          .map(pull);
        return;
      }
      case 'push':
        yield* localEmailNames.map(
          (name) =>
            /** @type {FrObject} */ ({
              ...forName(name),
              run: (token) => withFCMEnv(tenant, () => updateEmailTemplates({ name }, token)),
            }),
        );
        return;
    }
  }

  /**
   * @param {string} tenant
   * @param {Operation} operation
   * @param {Promise<string[]>} realmsPromise
   * @param {Promise<string>} tokenPromise
   * @returns {AsyncGenerator<FrObject>}
   */
  async function* listJourneys(tenant, operation, realmsPromise, tokenPromise) {
    const forName = (/** @type {string} */ realm, /** @type {string} */ name) => ({
      label: `journey ${realm} ${name}`,
      path: `realms/${realm}/journeys/${name}/${name}.json`,
    });
    const localRealmJourneyNames = (await glob(join(rootDir, 'realms', '*', 'journeys', '*', '*.json'))).map(
      (filePath) =>
        /** @type {[string, string]} */ ([
          basename(dirname(dirname(dirname(filePath)))),
          JSON.parse(readFileSync(filePath, 'utf8'))._id,
        ]),
    );
    switch (operation) {
      case 'pull': {
        const pull = (/** @type {[string, string]} */ [realm, name]) =>
          /** @type {FrObject} */ ({
            ...forName(realm, name),
            run: (token) => exportJourneys(join(rootDir, 'realms'), tenant, [realm], name, true, token),
          });
        yield* localRealmJourneyNames.map(pull);
        const localRealmJourneyNamesSet = new Set(localRealmJourneyNames.map(([realm, name]) => `${realm}/${name}`));

        const token = await tokenPromise;
        const journeyNamesForRealms = (await realmsPromise).map((realm) =>
          restGet(
            new URL(
              `/am/json/realms/root/realms/${realm}/realm-config/authentication/authenticationtrees/trees?_queryFilter=true&_fields=_id`,
              tenant,
            ).toString(),
            null,
            token,
          ).then((/** @type {{ data: { result: { _id: string }[] } }} */ response) =>
            response.data.result
              .map((content) => [realm, content._id])
              .filter(([realm, name]) => !localRealmJourneyNamesSet.has(`${realm}/${name}`))
              .map(pull),
          ),
        );
        yield* (await Promise.all(journeyNamesForRealms)).flat(1);
        return;
      }
      case 'push':
        yield* localRealmJourneyNames.map(
          ([realm, name]) =>
            /** @type {FrObject} */ ({
              ...forName(realm, name),
              run: (token) =>
                withFCMEnv(tenant, () => updateAuthTrees({ realm, name, 'push-dependencies': true }, token)),
            }),
        );
        return;
    }
  }

  /**
   * @param {string} tenant
   * @param {Promise<string>} tokenPromise
   * @returns {Promise<string[]>}
   */
  async function listRealms(tenant, tokenPromise) {
    const response = await restGet(
      new URL('/am/json/global-config/realms/?_queryFilter=true', tenant).toString(),
      {},
      await tokenPromise,
    );
    // TODO: active realms only
    return response.data.result.map((/** @type {{ name: string }} */ realm) => realm.name);
  }

  /**
   * @param {string} tenant
   * @param {Operation} operation
   * @param {Promise<string>} tokenPromise
   * @returns {{ openidmConfigNames: Promise<string[]> } | undefined}
   */
  function cacheQueryResults(tenant, operation, tokenPromise) {
    if (operation === 'pull') {
      return {
        openidmConfigNames: tokenPromise
          .then((token) =>
            restGet(new URL('/openidm/config?_queryFilter=true&_fields=_id', tenant).toString(), {}, token),
          )
          .then((response) => response.data.result.map((/** @type {{ _id: string }} */ content) => content._id)),
      };
    }
    return undefined;
  }

  /**
   * @param {string} tenant
   * @param {Operation} operation
   * @param {Promise<string>} tokenPromise
   * @returns {AsyncGenerator<FrObject>}
   */
  async function* listObjects(tenant, operation, tokenPromise) {
    const realmsPromise = listRealms(tenant, tokenPromise);
    const queryCaches = cacheQueryResults(tenant, operation, tokenPromise);
    yield* listEmailTemplates(tenant, operation, queryCaches);
    yield* listJourneys(tenant, operation, realmsPromise, tokenPromise);
    yield* listLocales(tenant, operation, queryCaches);
    yield* listSingletonObjects(tenant, operation);
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
   * @param {Promise<string>} tokenPromise
   */
  async function filesToObjects(tenant, operation, argvPaths, tokenPromise) {
    argvPaths = argvPaths.map((argvPath) => relative(rootDir, argvPath));
    const objects = [];
    for await (const object of listObjects(tenant, operation, tokenPromise)) {
      if (argvPaths.some((argvPath) => argvPath.startsWith(object.path))) {
        objects.push(object);
      }
    }
    return objects;
  }

  /**
   * @param {string} tenant
   * @param {Promise<string>} tokenPromise
   * @param {Operation} operation
   */
  async function pickObjects(tenant, operation, tokenPromise) {
    const objects = listObjects(tenant, operation, tokenPromise);
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
    const objects = argv.length
      ? await filesToObjects(tenant, operation, argv, tokenPromise)
      : await pickObjects(tenant, operation, tokenPromise);

    return Promise.all(objects.map(async ({ run }) => run(await tokenPromise)));
  });
  return connectionsPromise;
}

module.exports.transport = transport;

if (require.main === module) {
  const rootDir = dirname(dirname(__filename));
  transport(rootDir, execSyncReal, spawnReal, process.argv.slice(2));
}
