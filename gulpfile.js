var gulp        = require('gulp');
var gutil       = require('gulp-util');
var zip         = require('gulp-zip');
var pipeline    = require('serverless-pipeline');
var install     = require('gulp-install');

var jshint      = require('gulp-jshint'); // copied from dromedary
var mocha       = require('gulp-mocha'); // copied from dromedary
var pjson       = require('./package.json');


var appName    = pjson.name;
var appVersion = pjson.version;
var stackName  = (gutil.env.stackName || appName);
var cfnBucket  = gutil.env.templateBucket;
var region = (gutil.env.region || process.env.AWS_DEFAULT_REGION || 'us-west-2');

console.log("APP NAME    = "+appName);
console.log("APP VERSION = "+appVersion);
console.log("STACK NAME  = "+stackName);
console.log("REGION      = "+region);

// add gulp tasks for pipeline
var opts = {
    stackName: stackName,
    region: region,
    cfnBucket: cfnBucket,

    githubToken: gutil.env.token,
    githubUser: 'stelligent',
    githubRepo: 'dromedary-serverless',
    githubBranch: 'refactor',

    testSiteFQDN: 'drom-test.elasticoperations.com',
    prodSiteFQDN: 'drom-prod.elasticoperations.com',
    distSitePath: 'dist/site.zip',
    distLambdaPath: 'dist/lambda.zip',
    distSwaggerPath: 'dist/swagger.json',
    gulpTestTask: 'test',
    gulpPackageTask: 'package'
};
pipeline.registerTasks(gulp, opts);



// TODO: move to pipeline action lambda
gulp.task('setup-target-url', function (cb) {
    app.getStack()
        .then(function(stack) {
            var siteUrl = stack.Outputs.filter(function (o) { return o.OutputKey == 'SiteURL'})[0].OutputValue;
            process.env.TARGET_URL = siteUrl;
            console.log("TARGET_URL => "+process.env.TARGET_URL);
            cb();
        })
        .catch(cb);
});

// Execute unit tests
gulp.task('unit-test', function () {
    return gulp.src('node_modules/dromedary/test/*.js', {read: false})
        .pipe(mocha({reporter: 'spec'}));
});
// JSHint
gulp.task('lint-app', function() {
    return gulp.src(['node_modules/dromedary/app.js', 'node_modules/dromedary/lib/*.js'])
        .pipe(jshint())
        .pipe(jshint.reporter('default', { verbose: true }))
        .pipe(jshint.reporter('fail'));
});
gulp.task('lint-site', function() {
    return gulp.src('node_modules/dromedary/public/charthandler.js')
        .pipe(jshint({ 'globals': { Chart: true, dromedaryChartHandler: true }}))
        .pipe(jshint.reporter('default', { verbose: true }))
        .pipe(jshint.reporter('fail'));
});


gulp.task('package-site', ['lint-site'],function () {
    return gulp.src('node_modules/dromedary/public/**/*')
        .pipe(zip(opts.distSitePath))
        .pipe(gulp.dest('.'));
});

gulp.task('dist-app', function() {
    return gulp.src(['package.json','index.js'])
        .pipe(gulp.dest('dist/app/'))
        .pipe(install({production: true}));
});

gulp.task('package-app', ['lint-app','unit-test','dist-app'], function () {
    return gulp.src(['!dist/app/package.json','!dist/app/**/aws-sdk{,/**}', 'dist/app/**/*'])
        .pipe(zip(opts.distLambdaPath))
        .pipe(gulp.dest('.'));
});

gulp.task('package-swagger', function() {
});

gulp.task('package',['package-site','package-app','package-swagger'],  function() {
});

// Execute functional tests
gulp.task('test', function (cb) {
    gulp.src('node_modules/dromedary/test-functional/*.js', {read: false})
        .pipe(mocha({reporter: 'spec'}));
});


