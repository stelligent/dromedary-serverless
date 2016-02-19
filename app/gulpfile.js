'use strict'

var gulp        = require('gulp');
var gutil       = require('gulp-util');

var appConfig = {
    region: (gutil.env.region || 'us-west-2'),
};

var gapp   = require('.');
gapp(gulp,appConfig);



