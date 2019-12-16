const core = require('@actions/core');
const exec = require('@actions/exec');
const fetch = require('node-fetch');
const fs = require('fs');
const semver = require('semver');
const os = require('os');

const temp = os.tmpdir();
const SCOPE_DSN = 'SCOPE_DSN';
const scopeDir = temp + '/.scope_dir';
const derivedDataPath = scopeDir + '/derived';
const xctestDir =  derivedDataPath + '/Build/Products/';
const testrunJson = scopeDir + '/testrun.json';

async function run() {
    try {
      const dsn = core.getInput('dsn') || process.env[SCOPE_DSN];
      const sdk = core.getInput('sdk') || 'iphonesimulator';
      const destination = core.getInput('destination') || 'platform=iOS Simulator,name=iPhone 11';
      const configuration = core.getInput('configuration') || 'Debug';

        //Read project
      const workspace  = await getWorkspace();
      let xcodeproj = await getXCodeProj();
      let isSPM = false;
      var projectParameter;

      if(workspace) {
          console.log(`Workspace selected: ${workspace}`);
          projectParameter = '-workspace ' + workspace;
      } else if (xcodeproj) {
          console.log(`Project selected: ${xcodeproj}`);
          projectParameter = '-project ' + xcodeproj;
      } else if (fs.existsSync('Package.swift')) {
          isSPM = true;
          xcodeproj = await generateProjectFromSPM();
          projectParameter = '-project ' + xcodeproj;
      }
      else {
          core.setFailed('Unable to find the workspace or xcodeproj. Please set with.workspace or.xcodeproj');
      }

      const scheme = await getScheme(workspace, xcodeproj);
      console.log(`Scheme selected: ${scheme}`);

      //copy configfile

      const configfileName = 'scopeConfig.xcconfig';

      const configFilePath = scopeDir + '/' + configfileName;

      if (!fs.existsSync(scopeDir)){
          fs.mkdirSync(scopeDir);
      }
      createXCConfigFile(configFilePath)

      //download scope
      await downloadLatestScope();

      //build for testing
      let buildCommand = 'xcodebuild build-for-testing -enableCodeCoverage YES -xcconfig ' + configFilePath + ' ' + projectParameter + ' -configuration '+ configuration +
          ' -scheme ' + scheme + ' -sdk ' + sdk + ' -derivedDataPath ' + derivedDataPath + ' -destination \"' + destination + '\"';
      const result = await exec.exec(buildCommand, null, null);

      uploadSymbols(projectParameter, scheme, dsn);

      //modify xctestrun with Scope variables
      let testRun = await getXCTestRun();
      let plutilExportCommand = 'plutil -convert json -o ' + testrunJson + ' ' + testRun;
      await exec.exec(plutilExportCommand, null, null );

      let jsonString = fs.readFileSync(testrunJson, "utf8");
      const testTargets = JSON.parse(jsonString);


      for( const target of Object.keys(testTargets) ) {
          if( target.charAt(0) !== '_' ) {
              await insertEnvVariables(testRun, target, dsn)
          }
      }
      //run tests
      let testCommand = 'xcodebuild test-without-building -enableCodeCoverage YES -xctestrun ' + testRun + ' -destination \"' + destination + '\"';
      let testError;
      try {
          await exec.exec(testCommand, null, null);
      } catch (error) {
          testError = error.message
      }

      //build command settings
      let buildCommandSettings = 'xcodebuild -showBuildSettings -json -configuration '+ configuration + ' build-for-testing -xcconfig ' + configFilePath + ' ' + projectParameter +
          ' -scheme ' + scheme + ' -sdk ' + sdk + ' -derivedDataPath ' + derivedDataPath + ' -destination \"' + destination + '\"';
      let auxOutput = '';
      const options = {};
      options.listeners = {
          stdout: (data) => {
              auxOutput += data.toString();
          }
      };
      await exec.exec(buildCommandSettings, null, options);
      const settingsArray = JSON.parse(auxOutput);
      for( const settings of settingsArray ) {
          if (settings.buildSettings['PACKAGE_TYPE'] !== 'com.apple.package-type.bundle.unit-test') {
              await runScopeCoverageWithSettings(settings.buildSettings, dsn);
          }
      }

      if (!dsn) {
          core.warning('SCOPE_DSN not found in secrets, results wont be uploaded to Scope app');
      }

      if (testError) {
          core.setFailed(testError.message);
      }
    } catch (error) {
      core.setFailed(error.message);
    }
  }


async function getWorkspace() {
    let workspace = core.getInput('workspace');
    if (!workspace) {
        let myOutput = '';
        const options = {};
        options.listeners = {
            stdout: (data) => {
                myOutput += data.toString();
                workspace = myOutput.split("\n").find(function(file) { return file.match(/\.xcworkspace$/); });
            }
        };
        await exec.exec('ls', null, options)
    }
    return workspace
}

async function getXCodeProj() {
    let xcodeproj = core.getInput('xcodeproj');
    if (!xcodeproj) {
        let myOutput = '';
        const options = {};
        options.listeners = {
            stdout: (data) => {
                myOutput += data.toString();
                xcodeproj = myOutput.split("\n").find(function(file) { return file.match(/\.xcodeproj/); });
            }
        };
        await exec.exec('ls', null, options)
    }
    return xcodeproj;
}

async function generateProjectFromSPM() {
    if( fs.existsSync('Package_iOS.swift')) {
        fs.renameSync('Package.swift', 'Package_orig.swift')
        fs.renameSync('Package_iOS.swift', 'Package.swift')
    }
    let generateProjectCommand = 'swift package generate-xcodeproj';
    const result = await exec.exec(generateProjectCommand, null, null);
    console.log(`SPM package`);
    xcodeproj = await getXCodeProj();
    return xcodeproj
}


async function getScheme(workspace, xcodeproj) {
    let scheme = core.getInput('scheme');
    if (!scheme) {
        let command;
        if(workspace) {
            command = 'xcodebuild -workspace ' + workspace + ' -list -json';
        } else {
            command = 'xcodebuild -project ' + xcodeproj + ' -list -json';
        }
        let myOutput = '';
        const options = {};
        options.listeners = {
            stdout: (data) => {
                myOutput += data.toString();
            }
        };
        await exec.exec(command, null, options);
        const info = JSON.parse(myOutput);
        const aux = info.workspace || info.project;
        const schemes = aux.schemes;
        console.log('Available schemes: ' + JSON.stringify(schemes));
        scheme = intelligentSelectScheme(schemes, aux);
    }
    return scheme
}

function intelligentSelectScheme(schemes, workspacePath) {
    if (schemes.length < 1) {
        return null
    }
    const workspaceName = workspacePath.name;
    if (schemes.includes(workspaceName)) {
        return workspaceName
    }
    var el = schemes.find(a =>a.includes(workspaceName));

    return el || schemes[0]
}

function createXCConfigFile(path) {
    let configText = `
 // Configuration settings file format documentation can be found at:
 // https://help.apple.com/xcode/#/dev745c5c974
 
 DEBUG_INFORMATION_FORMAT = dwarf-with-dsym
` +
'FRAMEWORK_SEARCH_PATHS = $(inherited) '+ scopeDir + '/scopeAgent\n' +
'OTHER_LDFLAGS =  $(inherited) -ObjC -framework ScopeAgent\n' +
'LD_RUNPATH_SEARCH_PATHS = $(inherited) '+ scopeDir + '/scopeAgent\n';

    fs.writeFileSync(path, configText,null);
}

async function downloadLatestScope() {
    const versionsUrl = 'https://releases.undefinedlabs.com/scope/agents/ios/ScopeAgent.json';
    const jsonResponse = await fetch(versionsUrl);
    const versions = await jsonResponse.json();
    let currentVersion = '0.0.1';
    Object.keys(versions).forEach(function (name) {
        if( semver.gt(name,currentVersion) ) {
            currentVersion = name
        }
    });
    const scopeURL = versions[currentVersion];
    const scopePath = scopeDir + '/scopeAgent.zip';
    await downloadFile(scopeURL, scopePath);

    const extractCommand = 'ditto -x -k ' + scopePath + ' ' + scopeDir + '/scopeAgent';
    await exec.exec(extractCommand, null, null );
}

const downloadFile = (async (url, path) => {
    const res = await fetch(url);
    const fileStream = fs.createWriteStream(path);
    await new Promise((resolve, reject) => {
        res.body.pipe(fileStream);
        res.body.on("error", (err) => {
            reject(err);
        });
        fileStream.on("finish", function() {
            resolve();
        });
    });
});

function uploadSymbols(projectParameter, scheme, dsn) {
    let runScriptCommand = 'sh -c ' + scopeDir + '/scopeAgent/ScopeAgent.framework/upload_symbols';
    exec.exec(runScriptCommand, null, {
        env: {
            ...process.env,
            SCOPE_DSN: dsn,
            TARGET_BUILD_DIR: xctestDir,
        },
        ignoreReturnCode: false
    })
}

async function getXCTestRun() {
    let myOutput = '';
    let testRun = '';
    const options = {};
    options.listeners = {
        stdout: (data) => {
            myOutput += data.toString();
            testRun = myOutput.split("\n").find(function(file) { return file.match(/\.xctestrun$/); });
        }
    };
    await exec.exec('ls ' + xctestDir, null, options);
    return xctestDir + testRun
}

async function runScopeCoverageWithSettings(buildSettings, dsn) {
    let runScriptCommand = 'sh -c ' + scopeDir + '/scopeAgent/ScopeAgent.framework/scope-coverage';
    await exec.exec(runScriptCommand, null, {
        env: {
            ...buildSettings,
            SCOPE_DSN: dsn,
            TMPDIR: os.tmpdir() + '/',
        },
        ignoreReturnCode: true
    })
}

async function insertEnvVariables( file, target, dsn) {
    await insertEnvVariable('SCOPE_DSN', dsn, file, target );
    await insertEnvVariable('SCOPE_COMMIT_SHA', process.env['GITHUB_SHA'] || '', file, target );
    await insertEnvVariable('GITHUB_REPOSITORY',process.env['GITHUB_REPOSITORY'] || '', file, target );
    await insertEnvVariable('SCOPE_SOURCE_ROOT',process.env['GITHUB_WORKSPACE'] || '', file, target );
    await insertEnvVariable('GITLAB_CI',process.env['GITLAB_CI'] || '', file, target );
    await insertEnvVariable('CI_JOB_ID',process.env['CI_JOB_ID'] || '', file, target );
    await insertEnvVariable('CI_JOB_URL',process.env['CI_JOB_URL'] || '', file, target );
    await insertEnvVariable('SCOPE_SET_GLOBAL_TRACER', "YES", file, target );
    const instrumentHTTP = core.getInput('instrumentHttpPayloads');
    if ( instrumentHTTP === 'true' ){
        await insertEnvVariable('SCOPE_INSTRUMENTATION_HTTP_PAYLOADS', "YES", file, target );
    }

}

async function insertEnvVariable( name, value, file, target) {
    if( value !== '') {
        let insertCommand = 'plutil -replace \"' + target + '.EnvironmentVariables.' + name + '\" -string ' + value + ' ' + file;
        await exec.exec(insertCommand, null, null);
    }
}


run();
