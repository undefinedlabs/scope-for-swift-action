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

        if (!dsn) {
            core.setFailed('Cannot find the Scope DSN');
        }

        //Read project
      const workspace  = await getWorkspace();
      const xcodeproj = await getXCodeProj();

      var projectParameter;

      if(workspace) {
          console.log(`Workspace selected: ${workspace}`);
          projectParameter = '-workspace ' + workspace;
      } else if (xcodeproj) {
          console.log(`Project selected: ${xcodeproj}`);
          projectParameter = '-project ' + xcodeproj;
      } else {
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
      let buildCommand = 'xcodebuild build-for-testing -xcconfig ' + configFilePath + ' ' + projectParameter +
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
      let testCommand = 'xcodebuild test-without-building -xctestrun ' + testRun + ' -destination \"' + destination + '\"';
      await exec.exec(testCommand, null, null );
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
        await exec.exec(command, null, options)
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
    return schemes[0]
}

function createXCConfigFile(path) {
    let configText = `
 // Configuration settings file format documentation can be found at:
 // https://help.apple.com/xcode/#/dev745c5c974
 
` +
'FRAMEWORK_SEARCH_PATHS = $(inherited) '+ scopeDir + '/scopeAgent\n' +
'OTHER_LDFLAGS =  $(inherited) -ObjC -framework ScopeAgent\n' +
'LD_RUNPATH_SEARCH_PATHS = $(inherited) '+ scopeDir + '/scopeAgent\n'

    fs.writeFileSync(path, configText,null);
}

async function downloadLatestScope() {
    const versionsUrl = 'https://releases.undefinedlabs.com/scope/agents/ios/ScopeAgent.json';
    const jsonResponse = await fetch(versionsUrl)
    const versions = await jsonResponse.json()
    let currentVersion = '0.0.1'
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
    await exec.exec('ls ' + xctestDir, null, options)
    return xctestDir + testRun
}

async function insertEnvVariables( file, target, dsn) {
    await insertEnvVariable('SCOPE_DSN', dsn, file, target );
    await insertEnvVariable('SCOPE_COMMIT_SHA', process.env['GITHUB_SHA'] || '', file, target );
    await insertEnvVariable('GITHUB_REPOSITORY',process.env['GITHUB_REPOSITORY'] || '', file, target );
    await insertEnvVariable('SCOPE_SOURCE_ROOT',process.env['GITHUB_WORKSPACE'] || '', file, target );
    await insertEnvVariable('GITLAB_CI',process.env['GITLAB_CI'] || '', file, target );
    await insertEnvVariable('CI_JOB_ID',process.env['CI_JOB_ID'] || '', file, target );
    await insertEnvVariable('CI_JOB_URL',process.env['CI_JOB_URL'] || '', file, target );
    await insertEnvVariable('SCOPE_INSTRUMENTATION_HTTP_PAYLOADS', "YES", file, target );
    await insertEnvVariable('SCOPE_SET_GLOBAL_TRACER', "YES", file, target );
}

async function insertEnvVariable( name, value, file, target) {
    if( value !== '') {
        let insertCommand = 'plutil -replace \"' + target + '.EnvironmentVariables.' + name + '\" -string ' + value + ' ' + file;
        await exec.exec(insertCommand, null, null);
    }
}


run();
