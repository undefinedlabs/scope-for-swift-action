const core = require('@actions/core');
const exec = require('@actions/exec');
const io = require('@actions/io');
const fetch = require('node-fetch');
const fs = require('fs');
const semver = require('semver');
const os = require('os');
const path = require('path');


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
      const agentVersion = core.getInput('agentVersion');

        let file_list = recFindByExt('.','xctestplan');
        for(let testPlanFile of file_list ){
            await deleteLinesContaining(testPlanFile, 'codeCoverage')
        }
        
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

      //enableCodeCoverage in xcodebuild doesn't work with test plans, configure them before
      configureTestPlansForCoverage(projectParameter, scheme);

      //copy configfile
      const configfileName = 'scopeConfig.xcconfig';

      const configFilePath = scopeDir + '/' + configfileName;

      if (!fs.existsSync(scopeDir)){
          fs.mkdirSync(scopeDir);
      }
      createXCConfigFile(configFilePath);


      //download scope
     await downloadLatestScope(agentVersion);

      //build for testing
      let buildCommand = 'xcodebuild build-for-testing -enableCodeCoverage YES -xcconfig ' + configFilePath + ' ' + projectParameter + ' -configuration '+ configuration +
          ' -scheme ' + scheme + ' -sdk ' + sdk + ' -derivedDataPath ' + derivedDataPath + ' -destination \"' + destination + '\"';
      const result = await exec.exec(buildCommand, null, null);

      uploadSymbols(projectParameter, scheme, dsn);

      //Fol all testruns that are configured
      let testRuns = await getXCTestRuns();
      let testError;

      for( const testRun of testRuns ) {
      //modify xctestrun with Scope variables

      let plutilExportCommand = 'plutil -convert json -o ' + testrunJson + ' ' + testRun;
      await exec.exec(plutilExportCommand, null, null );

      let jsonString = fs.readFileSync(testrunJson, "utf8");
      const testTargets = JSON.parse(jsonString);

      for( const target of Object.keys(testTargets) ) {
        if( target.charAt(0) !== '_' ) {
          if( testTargets[target].TestingEnvironmentVariables ) {
            await insertEnvVariables(testRun, target, dsn)
          } else if ( target === 'TestConfigurations') {
              let configurationNumber = 0;
              for (const configuration of testTargets['TestConfigurations']) {
                  let testNumber = 0;
                  for (const test of configuration['TestTargets']) {
                      await insertEnvVariables(testRun, target + '.' + configurationNumber + '.' + 'TestTargets' + '.' + testNumber, dsn)
                  }
              }
          }
        }
      }
      //run tests
      let testCommand = 'xcodebuild test-without-building -enableCodeCoverage YES -xctestrun ' + testRun + ' -destination \"' + destination + '\"';
      try {
          await exec.exec(testCommand, null, null);
      } catch (error) {
          testError = error.message
      }
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
              await runScopeCoverageWithSettings(settings.buildSettings, dsn, isSPM);
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
        fs.renameSync('Package.swift', 'Package_orig.swift');
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

async function downloadLatestScope(agentVersion) {
    const versionsUrl = 'https://releases.undefinedlabs.com/scope/agents/ios/ScopeAgent.json';
    const jsonResponse = await fetch(versionsUrl);
    const versions = await jsonResponse.json();
    let currentVersion = '0.0.1';
    Object.keys(versions).forEach(function (name) {
        if( semver.gt(name,currentVersion) && !semver.prerelease(name) ) {
            currentVersion = name
        }
    });
    const scopeURL = versions[agentVersion] || versions[currentVersion];
    const scopePath = scopeDir + '/scopeAgent.zip';
    console.log(`Scope agent downloading: ${scopeURL}`);
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

async function getXCTestRuns() {
    let myOutput = '';
    let testRuns = [''];
    const options = {};
    options.listeners = {
        stdout: (data) => {
            myOutput += data.toString();
            testRuns = myOutput.split("\n").filter(function(file) { return file.match(/\.xctestrun$/); });
        }
    };
    await exec.exec('ls ' + xctestDir, null, options);
    testRuns.forEach(function(part, index, theArray) {
        theArray[index] = xctestDir + part;
    });
    return testRuns
}

async function runScopeCoverageWithSettings(buildSettings, dsn, isSPM) {
    let runScriptCommand = 'sh -c ' + scopeDir + '/scopeAgent/ScopeAgent.framework/scope-coverage';
    await exec.exec(runScriptCommand, null, {
        env: {
            ...buildSettings,
            SCOPE_DSN: dsn,
            TMPDIR: os.tmpdir() + '/',
            PRODUCT_BUNDLE_IDENTIFIER: isSPM ? '' : buildSettings.PRODUCT_BUNDLE_IDENTIFIER
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

async function configureTestPlansForCoverage( projectParameter, scheme ) {
    //Check if project is configured with test plans
    let showTestPlansCommand = 'xcodebuild -showTestPlans -json ' + projectParameter + ' -scheme ' + scheme;
    let auxOutput = '';
    const options = {};
    options.listeners = {
        stdout: (data) => {
            auxOutput += data.toString();
        }
    };
    await exec.exec(showTestPlansCommand, null, options);
    const showTestPlans = JSON.parse(auxOutput);
    if( showTestPlans.testPlans === null ) {
        return;
    }

    //If uses testplan configure to use code coverage
    let file_list = recFindByExt('.','xctestplan');
    for(let testPlanFile of file_list ){
        await deleteLinesContaining(testPlanFile, 'codeCoverage')
    }
}

function recFindByExt(base,ext,files,result)
{
    files = files || fs.readdirSync(base);
    result = result || [];

    files.forEach(
        function (file) {
            var newbase = path.join(base,file);
            if ( fs.statSync(newbase).isDirectory() )
            {
                result = recFindByExt(newbase,ext,fs.readdirSync(newbase),result)
            }
            else
            {
                if ( file.substr(-1*(ext.length+1)) === '.' + ext )
                {
                    result.push(newbase)
                }
            }
        }
    );
    return result
}

async function deleteLinesContaining( file, match ) {
    let newName = file + '_old'
    await io.mv(file, newName );
    fs.readFile(newName, {encoding: 'utf-8'}, function(err, data) {
        if (err) throw error;

        let dataArray = data.split('\n'); // convert file data in an array
        const searchKeyword = match; // we are looking for a line, contains, key word 'user1' in the file
        let lastIndex = -1; // let say, we have not found the keyword

        for (let index=0; index<dataArray.length; index++) {
            if (dataArray[index].includes(searchKeyword)) { // check if a line contains the 'user1' keyword
                lastIndex = index; // found a line includes a 'user1' keyword
                break;
            }
        }

        dataArray.splice(lastIndex, 1); // remove the keyword 'user1' from the data Array

        // UPDATE FILE WITH NEW DATA
        // IN CASE YOU WANT TO UPDATE THE CONTENT IN YOUR FILE
        // THIS WILL REMOVE THE LINE CONTAINS 'user1' IN YOUR shuffle.txt FILE
        const updatedData = dataArray.join('\n');
        fs.writeFile(file, updatedData, (err) => {
            if (err) throw err;
            console.log ('Successfully updated the file data');
        });

    });
}
run();
