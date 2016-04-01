// modules
var _ = require('lodash');
var beautifyHtml = require('js-beautify').html;
var chalk = require('chalk');
var fs = require('fs');
var globby = require('globby');
var Handlebars = require('handlebars');
var inflect = require('i')();
var matter = require('gray-matter');
var md = require('markdown-it')({ html: true, linkify: true });
var mkdirp = require('mkdirp');
var path = require('path');
var rmdir = require('rimraf');
var sortObj = require('sort-object');
var yaml = require('js-yaml');


/**
 * Default options
 * @type {Object}
 */
var defaults = {
	/**
	 * ID (filename) of default layout
	 * @type {String}
	 */
	layout: 'default',

	/**
	 * Layout templates
	 * @type {(String|Array)}
	 */
	layouts: ['src/views/layouts/*'],

	/**
	 * Layout includes (partials)
	 * @type {String}
	 */
	layoutIncludes: ['src/views/layouts/includes/*'],

	/**
	 * Pages to be inserted into a layout
	 * @type {(String|Array)}
	 */
	views: ['src/views/**/*', '!src/views/+(layouts)/**'],

	/**
	 * Materials - snippets turned into partials
	 * @type {(String|Array)}
	 */
	materials: ['src/materials/**/*'],

	/**
	 * JSON or YAML data models that are piped into views
	 * @type {(String|Array)}
	 */
	data: ['src/data/**/*.{json,yml}'],

	/**
	 * Markdown files containing toolkit-wide documentation
	 * @type {(String|Array)}
	 */
	docs: ['src/docs/**/*.md'],

	/**
	 * Keywords used to access items in views
	 * @type {Object}
	 */
	keys: {
		materials: 'materials',
		views: 'views',
		docs: 'docs'
	},

	/**
	 * Location to write files
	 * @type {String}
	 */
	dest: 'dist',

	/**
	 * beautifier options
	 * @type {Object}
	 */
	beautifier: {
		indent_size: 1,
		indent_char: '	',
		indent_with_tabs: true
	},

	/**
	 * Function to call when an error occurs
	 * @type {Function}
	 */
	onError: null,

	/**
	 * Whether or not to log errors to console
	 * @type {Boolean}
	 */
	logErrors: false,

	/**
	 * Whether or not to wrap partials in descriptive HTML comments
	 * @type {Boolean}
	 */
	encloseInComments: false,

	/**
	 * Whether or not to wrap partials in a hard-resetting CSS container
	 * @type {Boolean}
	 */
	wrapAndHardResetMaterials: false

};


/**
 * Merged defaults and user options
 * @type {Object}
 */
var options = {};


/**
 * Assembly data storage
 * @type {Object}
 */
var assembly = {
	/**
	 * Contents of each layout file
	 * @type {Object}
	 */
	layouts: {},

	/**
	 * Parsed JSON data from each data file
	 * @type {Object}
	 */
	data: {},

	/**
	 * Meta data for materials, grouped by "collection" (sub-directory); contains name and sub-items
	 * @type {Object}
	 */
	materials: {},

	/**
	 * Each material's front-matter data
	 * @type {Object}
	 */
	materialData: {},

	/**
	 * Meta data for user-created views (views in views/{subdir})
	 * @type {Object}
	 */
	views: {},

	/**
	 * Meta data (name, sub-items) for doc file
	 * @type {Object}
	 */
	docs: {}
};


/**
 * Filter a (presumed) filename
 * @param  {String} name
 * @example
 * 'foo.html' -> 'foo'
 * '02-bar.html' -> 'bar'
 * @return {String}
 */
var filterName = function (name, preserveNumbers) {
	// replace spaces with dashes; remove excluding underscores; trim
	return ((preserveNumbers) ? name : name.replace(/(^[0-9|\.\-]+|)(__|)/, '')).trim().replace(/\s/g, '-');
};


/**
 * Get the name of a file (minus extension) from a path
 * @param  {String} filePath
 * @example
 * './src/materials/structures/foo.html' -> 'foo'
 * './src/materials/structures/02-bar.html' -> 'bar'
 * @return {String}
 */
var getName = function (filePath, preserveNumbers) {
	var name = path.basename(filePath, path.extname(filePath));
	return filterName(name, preserveNumbers);
};


/**
 * See if transformed filename has leading "__" to hide it from the menu
 * @param  {String} filePath
 * @example
 * './src/materials/structures/__foo.html' -> true
 * './src/materials/structures/02-bar.html' -> false
 * @return {Bool}
 */
var isExcluded = function (filePath) {
	var name = path.basename(filePath);
	return name.match(/(^[0-9\.]+|)(__)/, "") ? true : false;
};


/**
 * Attempt to read front matter, handle errors
 * @param  {String} file Path to file
 * @return {Object}
 */
var getMatter = function (file) {
	return matter.read(file, {
		parser: require('js-yaml').safeLoad
	});
};


/**
 * Handle errors
 * @param  {Object} e Error object
 */
var handleError = function (e) {

	// default to exiting process on error
	var exit = true;

	// construct error object by combining argument with defaults
	var error = _.assign({}, {
		name: 'Error',
		reason: '',
		message: 'An error occurred',
	}, e);

	// call onError
	if (_.isFunction(options.onError)) {
		options.onError(error);
		exit = false;
	}

	// log errors
	if (options.logErrors) {
		console.error(chalk.bold.red('Error (fabricator-assemble): ' + e.message + '\n'), e.stack);
		exit = false;
	}

	// break the build if desired
	if (exit) {
		console.error(chalk.bold.red('Error (fabricator-assemble): ' + e.message + '\n'), e.stack);
		process.exit(1);
	}

};


/**
 * Build the template context by merging context-specific data with assembly data
 * @param  {Object} data
 * @return {Object}
 */
var buildContext = function (data, hash) {

	// set keys to whatever is defined
	var materials = {};
	materials[options.keys.materials] = assembly.materials;

	var views = {};
	views[options.keys.views] = assembly.views;

	var docs = {};
	docs[options.keys.docs] = assembly.docs;

	return _.assign({}, data, assembly.data, assembly.materialData, materials, views, docs, hash);

};


/**
 * Convert a file name to title case
 * @param  {String} str
 * @return {String}
 */
var toTitleCase = function(str) {
	return str.replace(/(\-|_)/g, ' ').replace(/\w\S*/g, function(word) {
		return word.charAt(0).toUpperCase() + word.substr(1).toLowerCase();
	});
};


/**
 * Insert the page into a layout
 * @param  {String} page
 * @param  {String} layout
 * @return {String}
 */
var wrapPage = function (page, layout) {
	return layout.replace(/\{\%\s?body\s?\%\}/, page);
};


/**
 * Parse each material - collect data, create partial
 */
var parseMaterials = function () {

	// reset object
	assembly.materials = {};

	// get files and dirs
	var files = globby.sync(options.materials, { nodir: true, nosort: true }).sort();

	// build a glob for identifying directories
	options.materials = (typeof options.materials === 'string') ? [options.materials] : options.materials;
	var dirsGlob = options.materials.map(function (pattern) {
		return path.dirname(pattern) + '/*/';
	});

	// get all directories
	// do a new glob; trailing slash matches only dirs
	var dirs = globby.sync(dirsGlob).map(function (dir) {
		return filterName(path.normalize(dir).split(/[/\\]/).slice(-2, -1)[0]);
	});


	// stub out an object for each collection and subCollection
	files.forEach(function (file) {

		var parent = filterName(path.normalize(path.dirname(file)).split(/[/\\]/).slice(-2, -1)[0]);
		var collection = filterName(path.normalize(path.dirname(file)).split(/[/\\]/).pop());
		var isSubCollection = (dirs.indexOf(getName(parent)) > -1);

		// get the material base dir for stubbing out the base object for each category (e.g. component, structure)
		var materialBase = (isSubCollection) ? parent : collection;


		// stub the base object
		assembly.materials[materialBase] = assembly.materials[materialBase] || {
			name: toTitleCase(materialBase),
			items: {},
			exclude: isExcluded(path.normalize(path.dirname(file)))
		};

	});


	// iterate over each file (material)
	files.forEach(function (file) {

		// get info
		var fileMatter = getMatter(file);
		var collection = filterName(path.normalize(path.dirname(file)).split(/[/\\]/).pop());
		var parent = filterName(path.normalize(path.dirname(file)).split(/[/\\]/).slice(-2, -1)[0]);
		var isSubCollection = (dirs.indexOf(parent) > -1);
		var id = ((isSubCollection) ? filterName(collection) + '.' + getName(file) : getName(file));
		var key = (isSubCollection) ? filterName(collection) + '.' + getName(file) : getName(file);

    // stub the sub-base object
		if (isSubCollection) {
			assembly.materials[parent].items[collection] = assembly.materials[parent].items[collection] || {
				name: toTitleCase(collection),
				items: {},
				exclude: isExcluded(path.normalize(path.dirname(file)).split(/[/\\]/).pop())
			};
		}

		// get material front-matter, omit `notes`
		var localData = _.omit(fileMatter.data, 'notes');

		// trim whitespace from material content
		var content = fileMatter.content.replace(/^(\s*(\r?\n|\r))+|(\s*(\r?\n|\r))+$/g, '');


		// capture meta data for the material
		if (!isSubCollection) {
			assembly.materials[collection].items[key] = {
				name: toTitleCase(id),
				notes: (fileMatter.data.notes) ? md.render(fileMatter.data.notes) : '',
				data: localData,
				exclude: isExcluded(file),
				bundle: (fileMatter.data.bundle == true) ? true : false,
				updated: fileMatter.data.updated
			};
		} else {
			assembly.materials[parent].items[collection].items[key] = {
				name: toTitleCase(id.split('.')[1]),
				notes: (fileMatter.data.notes) ? md.render(fileMatter.data.notes) : '',
				data: localData,
				exclude: isExcluded(file),
				bundle: (fileMatter.data.bundle == true) ? true : false,
				updated: fileMatter.data.updated
			};
		}


		// store material-name-spaced local data in template context
		assembly.materialData[id.replace(/\./g, '-')] = localData;


		// replace local fields on the fly with name-spaced keys
		// this allows partials to use local front-matter data
		// only affects the compilation environment
		if (!_.isEmpty(localData)) {
			_.forEach(localData, function (val, key) {
				// {{field}} => {{material-name.field}}
				var regex = new RegExp('(\\{\\{[#\/]?)(\\s?' + key + '+?\\s?)(\\}\\})', 'g');
				content = content.replace(regex, function (match, p1, p2, p3) {
					return p1 + id.replace(/\./g, '-') + '.' + p2.replace(/\s/g, '') + p3;
				});
			});
		}

    if (options.wrapAndHardResetMaterials) {

      content = ("<div class=\"hard-reset\" data-toolkit>\n" + content + "\n</div>\n");

    } // end if

    content = options.encloseInComments ? ("<!-- START '" + id + "' -->\n" + content + "\n<!-- END '" + id + "' -->\n") : content;

		// register the partial
		Handlebars.registerPartial(id, content);

	});


	// iterate over each file (material) again and attempt to bundle individual materials
	files.forEach(function (file) {

		// get info
		var collection = filterName(path.normalize(path.dirname(file)).split(/[/\\]/).pop());
		var parent = filterName(path.normalize(path.dirname(file)).split(/[/\\]/).slice(-2, -1)[0]);
		var isSubCollection = (dirs.indexOf(parent) > -1);
		var id = ((isSubCollection) ? filterName(collection) + '.' + getName(file) : getName(file));
		var key = (isSubCollection) ? filterName(collection) + '.' + getName(file) : getName(file);
    var data;

		// get data
		if (!isSubCollection) {
			data = assembly.materials[collection].items[key];
		} else {
			data = assembly.materials[parent].items[collection].items[key];
		}

    if (data && data.bundle) {

      // get page gray matter and content
      var pageMatter = getMatter(file),
          baseName = filterName(path.basename(file, ".html"));

      // write raw module
      var source = "{{> " + key + " }}",
          context = buildContext(data),
          template = Handlebars.compile(source),
          filePath = path.normalize(path.join(options.dest, "bundles", baseName, filterName(path.basename(file))));

      // change extension to .html
      filePath = filterName(filePath.replace(/\.[0-9a-z]+$/, ("." + (data.data.extension || "html"))));

      // write file
      mkdirp.sync(path.dirname(filePath));
      fs.writeFileSync(filePath, template(context));

      // write module example
      // source = wrapPage("{{> " + key + " }}", assembly.layouts[pageMatter.data.layout || options.layout]);
      // template = Handlebars.compile(source);
      // filePath = path.normalize(path.join(options.dest, "bundles", baseName, "example", filterName(path.basename(file))));

      // change extension to .html
      // filePath = filterName(filePath.replace(/\.[0-9a-z]+$/, ("." + (data.data.extension || "html"))));

      // write file
      // mkdirp.sync(path.dirname(filePath));
      // fs.writeFileSync(filePath, template(context));

      // try to copy module css
      try {

        var source = path.normalize(path.join(options.dest, "assets", "toolkit", "styles", "bundles", baseName + ".css")),
            dest = path.normalize(path.join(options.dest, "bundles", baseName, baseName + ".css"));

        fs.writeFileSync(dest, fs.readFileSync(source));

      } catch (e) {}

      // try to copy module js
      try {

        var source = path.normalize(path.join(options.dest, "assets", "toolkit", "scripts", "bundles", baseName + ".js")),
            dest = path.normalize(path.join(options.dest, "bundles", baseName, baseName + ".js"));

        fs.writeFileSync(dest, fs.readFileSync(source));

      } catch (e) {}

      // try to copy toolkit css
      try {

        var source = path.normalize(path.join(options.dest, "assets", "toolkit", "styles", "toolkit.css")),
            dest = path.normalize(path.join(options.dest, "bundles", baseName, "toolkit.css"));

        fs.writeFileSync(dest, fs.readFileSync(source));

      } catch (e) {}

      // try to copy toolkit js
      try {

        var source = path.normalize(path.join(options.dest, "assets", "toolkit", "scripts", "toolkit.js")),
            dest = path.normalize(path.join(options.dest, "bundles", baseName, "toolkit.js"));

        fs.writeFileSync(dest, fs.readFileSync(source));

      } catch (e) {}

      // try to copy vendor css
      try {

        var source = path.normalize(path.join(options.dest, "assets", "toolkit", "styles", "vendor", "vendor.css")),
            dest = path.normalize(path.join(options.dest, "bundles", baseName, "vendor.css"));

        fs.writeFileSync(dest, fs.readFileSync(source));

      } catch (e) {}

      // try to copy vendor js
      try {

        var source = path.normalize(path.join(options.dest, "assets", "toolkit", "scripts", "vendor", "vendor.js")),
            dest = path.normalize(path.join(options.dest, "bundles", baseName, "vendor.js"));

        fs.writeFileSync(dest, fs.readFileSync(source));

      } catch (e) {}

      if (data.data.websphere && _.has(assembly.data, "globals")) { // IBM WebSphere Commerce bundling rules

        if (!_.has(assembly.data.globals, "websphere_config")) {

          console.log(chalk.bold.red("Error (websphere bundling): globals.websphere_config doesn't exist!"));

        } // end if

        var config = assembly.data.globals.websphere_config || {};

        if (!_.has(config, "webcontent_folder") ||
            !_.has(config, "widgets_namespace") ||
            !_.has(config, "widget_prefix")) {

          console.log(chalk.bold.red("Error (websphere bundling): globals.websphere_config is missing data"));

        } else {

          try {

            var widget_name    = assembly.data.globals.websphere_config.widget_prefix + toTitleCase(baseName).replace(" ", "") + "Widget";
            var widgets_folder = "Widgets-" + assembly.data.globals.websphere_config.webcontent_folder;

            var widget_path = path.normalize(path.join(options.dest,
                                                       "bundles",
                                                       "websphere",
                                                       "Stores",
                                                       "WebContent",
                                                       widgets_folder,
                                                       assembly.data.globals.websphere_config.widgets_namespace + "." + widget_name));

            var javascript_path = path.normalize(path.join(widget_path,
                                                           "javascript"));

            mkdirp.sync(javascript_path);

            // try to write module JSPx's

            var jsp = "\n\
<%--  The following code is created as an example. Modify the generated code and add any additional required code.  --%>\n\
<%-- BEGIN "+ widget_name +".jsp --%>\n\
\n\
<%@include file=\"/Widgets_701/Common/EnvironmentSetup.jspf\"%>\n\
<fmt:setBundle basename=\"/"+ widgets_folder +"/Properties/"+ widget_name +"_text\" var=\""+ widget_name +"_text\" />\n\
<c:set var=\"widgetPreviewText\" value=\"${"+ widget_name +"_text}\"/>\n\
<c:set var=\"emptyWidget\" value=\"false\"/>\n\
\n\
<link rel=\"stylesheet\" href=\"/"+ widgets_folder + "/Common/styles/"+ baseName + ".css\">\n\
\n\
<%@include file=\""+ widget_name +"_Data.jspf\"%>\n\
\n\
\n\
<%@ include file=\"/Widgets_701/Common/StorePreviewShowInfo_Start.jspf\" %>\n\
\n\
<%@ include file=\""+ widget_name +"_UI.jspf\"%>\n\
\n\
<%@ include file=\"/Widgets_701/Common/StorePreviewShowInfo_End.jspf\" %>\n\
\n\
<%-- END "+ widget_name +".jsp --%>\n\
";

            var dest = path.normalize(path.join(widget_path,
                                                widget_name + ".jsp"));

            fs.writeFileSync(dest, jsp);

            var ui = "\n\
<%--  The following code is created as an example. Modify the generated code and add any additional required code.  --%>\n\
<div id=\"widgetExample\" >\n\
"+ template(context) +"\n\
</div>\n\
";
            var dest = path.normalize(path.join(widget_path,
                                                widget_name + "_UI.jspf"));

            fs.writeFileSync(dest, ui);

            var dest = path.normalize(path.join(widget_path,
                                                widget_name + "_Data.jspf"));

            fs.writeFileSync(dest, '<%--  Add your data related code here --%>');

            // try to copy module js
            try {

              var source = path.normalize(path.join(options.dest, "assets", "toolkit", "scripts", "bundles", baseName + ".js")),
                  dest = path.normalize(path.join(javascript_path, baseName + ".js"));

              fs.writeFileSync(dest, fs.readFileSync(source));

            } catch (e) {}

            var css_path = path.normalize(path.join(options.dest,
                                                    "bundles",
                                                    "websphere",
                                                    "Stores",
                                                    "WebContent",
                                                    widgets_folder,
                                                    "Common",
                                                    "styles"));

            mkdirp.sync(css_path);

            var javascript_path = path.normalize(path.join(options.dest,
                                                           "bundles",
                                                           "websphere",
                                                           "Stores",
                                                           "WebContent",
                                                           widgets_folder,
                                                           "Common",
                                                           "scripts"));

            mkdirp.sync(javascript_path);

            // try to copy module css
            try {

              var source = path.normalize(path.join(options.dest, "assets", "toolkit", "styles", "bundles", baseName + ".css")),
                  dest = path.normalize(path.join(css_path, baseName + ".css"));

              fs.writeFileSync(dest, fs.readFileSync(source));

            } catch (e) {}

            // try to copy toolkit css
            try {

              var source = path.normalize(path.join(options.dest, "assets", "toolkit", "styles", "toolkit.css")),
                  dest = path.normalize(path.join(css_path, "toolkit.css"));

              fs.writeFileSync(dest, fs.readFileSync(source));

            } catch (e) {}

            // try to copy vendor css
            try {

              var source = path.normalize(path.join(options.dest, "assets", "toolkit", "styles", "vendor", "vendor.css")),
                  dest = path.normalize(path.join(css_path, "vendor.css"));

              fs.writeFileSync(dest, fs.readFileSync(source));

            } catch (e) {}

            // try to copy toolkit js
            try {

              var source = path.normalize(path.join(options.dest, "assets", "toolkit", "scripts", "toolkit.js")),
                  dest = path.normalize(path.join(javascript_path, "toolkit.js"));

              fs.writeFileSync(dest, fs.readFileSync(source));

            } catch (e) {}

            // try to copy vendor js
            try {

              var source = path.normalize(path.join(options.dest, "assets", "toolkit", "scripts", "vendor", "vendor.js")),
                  dest = path.normalize(path.join(javascript_path, "vendor.js"));

              fs.writeFileSync(dest, fs.readFileSync(source));

            } catch (e) {}

            var images_path = path.normalize(path.join(options.dest,
                                                    "bundles",
                                                    "websphere",
                                                    "Stores",
                                                    "WebContent",
                                                    widgets_folder,
                                                    "images"));

            mkdirp.sync(images_path);

            var properties_path = path.normalize(path.join(options.dest,
                                                           "bundles",
                                                           "websphere",
                                                           "Stores",
                                                           "WebContent",
                                                           widgets_folder,
                                                           "Properties"));

            mkdirp.sync(properties_path);

            var text = "# --The following code is created as example. Modify the generated code and add any additional required code. --\n\
\n\
WidgetTypeDisplayText_"+ widget_name +"="+ toTitleCase(baseName) +" widget\n\
\n\
";

            var dest = path.normalize(path.join(properties_path,
                                                widget_name + "_text.properties"));

            fs.writeFileSync(dest, text);

            var dest = path.normalize(path.join(properties_path,
                                                widget_name + "_text_en_US.properties"));

            fs.writeFileSync(dest, text);

          } catch (e) { console.log(e); }

        } // end if

      }

    }

	});

/*
	// sort materials object alphabetically
	assembly.materials = sortObj(assembly.materials, 'order');

	for (var collection in assembly.materials) {
		assembly.materials[collection].items = sortObj(assembly.materials[collection].items, 'order');
	}
*/
};


/**
 * Parse markdown files as "docs"
 */
var parseDocs = function () {

	// reset
	assembly.docs = {};

	// get files
	var files = globby.sync(options.docs, { nodir: true });

	// iterate over each file (material)
	files.forEach(function (file) {

		var id = getName(file);

		// save each as unique prop
		assembly.docs[id] = {
			name: toTitleCase(id),
			content: md.render(fs.readFileSync(file, 'utf-8')),
			exclude: isExcluded(file)
		};

	});

};


/**
 * Parse layout files
 */
var parseLayouts = function () {

	// reset
	assembly.layouts = {};

	// get files
	var files = globby.sync(options.layouts, { nodir: true });

	// save content of each file
	files.forEach(function (file) {
		var id = getName(file);
		var content = fs.readFileSync(file, 'utf-8');
		assembly.layouts[id] = content;
	});

};


/**
 * Register layout includes has Handlebars partials
 */
var parseLayoutIncludes = function () {

	// get files
	var files = globby.sync(options.layoutIncludes, { nodir: true });

	// save content of each file
	files.forEach(function (file) {
		var id = getName(file);
		var content = fs.readFileSync(file, 'utf-8');

    content = options.encloseInComments ? ("<!-- START '" + id + "' -->\n" + content + "\n<!-- END '" + id + "' -->\n") : content;

		Handlebars.registerPartial(id, content);
	});

};


/**
 * Parse data files and save JSON
 */
var parseData = function () {

	// reset
	assembly.data = {};

	// get files
	var files = globby.sync(options.data, { nodir: true });

	// save content of each file
	files.forEach(function (file) {
		var id = getName(file);
		var content = yaml.safeLoad(fs.readFileSync(file, 'utf-8'));
		assembly.data[id] = content;
	});

};


/**
 * Get meta data for views
 */
var parseViews = function () {

	// reset
	assembly.views = {};

	// get files
	var files = globby.sync(options.views, { nodir: true });

	files.forEach(function (file) {

		var id = getName(file, true);

		// determine if view is part of a collection (subdir)
		var dirname = path.normalize(path.dirname(file)).split(/[/\\]/).pop(),
			collection = (dirname !== options.keys.views) ? dirname : '';

		var fileMatter = getMatter(file),
			fileData = _.omit(fileMatter.data, 'notes');

		// if this file is part of a collection
		if (collection) {

			// create collection if it doesn't exist
			assembly.views[collection] = assembly.views[collection] || {
				name: toTitleCase(collection),
				items: {}
			};

			// store view data
			assembly.views[collection].items[id] = {
				name: toTitleCase(id),
				data: fileData,
				exclude: isExcluded(file),
				updated: fileMatter.data.updated
			};

		}

	});

};


/**
 * Register new Handlebars helpers
 */
var registerHelpers = function () {

	// get helper files
	var resolveHelper = path.join.bind(null, __dirname, 'helpers');
	var localHelpers = fs.readdirSync(resolveHelper());
	var userHelpers = options.helpers;

	// register local helpers
	localHelpers.map(function (helper) {
		var key = helper.match(/(^\w+?-)(.+)(\.\w+)/)[2];
		var path = resolveHelper(helper);
		Handlebars.registerHelper(key, require(path));
	});


	// register user helpers
	for (var helper in userHelpers) {
		if (userHelpers.hasOwnProperty(helper)) {
			Handlebars.registerHelper(helper, userHelpers[helper]);
		}
	}


	/**
	 * Helpers that require local functions like `buildContext()`
	 */

	/**
	 * `material`
	 * @description Like a normal partial include (`{{> partialName }}`),
	 * but with some additional templating logic to help with nested block iterations.
	 * The name of the helper is the singular form of whatever is defined as the `options.keys.materials`
	 * @example
	 * {{material name context}}
	 */
	Handlebars.registerHelper(inflect.singularize(options.keys.materials), function (name, context, opts) {

		var key = filterName(name);

		// attempt to find pre-compiled partial
		var template = Handlebars.partials[key],
			fn;

		// compile partial if not already compiled
		if (!_.isFunction(template)) {
			fn = Handlebars.compile(template);
		} else {
			fn = template;
		}

		// return beautified html with trailing whitespace removed
		return beautifyHtml(fn(buildContext(context, opts.hash)).replace(/^\s+/, ''), options.beautifier);

	});

	/**
	 * Custom helpers that are more fabricator-oriented than fabricator-assemble-oriented
	 */

	/**
	 * `lang`
	 * @description Given an object, this helper looks to see if "language" has been defined in
   * globals.json and then checks to see if object[globals.language] exists; if so, return it,
   * otherwise return the object passed in. This lets you structure data to have alternating
   * values in case you need to quickly see your toolkit in a different language.
	 * @example
   *
   * ---------------------------------------------------------------------------------------------
   *
   *   globals.json:
   *
   *     {"language" : "german"}
   *
   * ---------------------------------------------------------------------------------------------
   *
   *   data-example.json:
   *
   *     {"people" :
   *       [{"name": {"english" : "Kevin", "german" : "Kevin [DE]"}},
   *        {"name": {"english" : "Sally", "german" : "Sally [DE]"}},
   *        {"name": "Ralph"},
   *        {"name": {"english" : "Beth", "german" : "Beth [DE]"}}
   *       ]
   *     }
   *
   * ---------------------------------------------------------------------------------------------
   *
   *   data-populator.html:
   *
   *    <li>​
   *      name: {{#if name }}{{ lang name }}{{ else }}Your Name{{/if}}
   *    </li>​
   *
   * ---------------------------------------------------------------------------------------------
   *
   *   usage:
   *
   *    {{#each data-example.people}}​
   *
   *      {{> data-populator}}
   *
   *    {{/each}}
   *
   * ---------------------------------------------------------------------------------------------
   *
   *   output:
   *
   *    <li>
   *      name: Kevin [DE]
   *    </li>
   *
   *    <li>
   *      name: Sally [DE]
   *    </li>
   *
   *    <li>
   *      name: Ralph
   *    </li>
   *
   *    <li>
   *      name: Beth [DE]
   *    </li>
   *
   * ---------------------------------------------------------------------------------------------
   */
  Handlebars.registerHelper("lang", function (object) {

    if (_.has(assembly.data, "globals") && _.has(assembly.data.globals, "language")) {

      var lang = assembly.data.globals.language;

      if (_.has(object, lang)) {

        return object[lang];

      } // end if

    } // end if

    return object;

  });

	/**
	 * `data`
	 * @description return assembly.data to isolate ONLY loaded data
	 * @example
   *
   *   {{#with (data)}}
   *
   *     {{> material-name}}
   *
   *   {{/with}}
   *
   */
	Handlebars.registerHelper("data", function () {

    return assembly.data;

	});

	/**
	 * `tot` ("this-or-that")
	 * @description pass in a value and a default, return the default if value is empty
	 * @example
   *
   *   {{ tot VARIABLE "Default Value" }}
   *
   */
	Handlebars.registerHelper("tot", function (a, b) {

    return a || b;

	});

};


/**
 * Setup the assembly
 * @param  {Objet} options	User options
 */
var setup = function (userOptions) {

	// merge user options with defaults
	options = _.merge({}, defaults, userOptions);

	// setup steps
	registerHelpers();
	parseLayouts();
	parseLayoutIncludes();
	parseData();
	parseMaterials();
	parseViews();
	parseDocs();

};


/**
 * Assemble views using materials, data, and docs
 */
var assemble = function () {

	// get files
	var files = globby.sync(options.views, { nodir: true });

	// create output directory if it doesn't already exist
	mkdirp.sync(options.dest);

	// iterate over each view
	files.forEach(function (file) {

		var id = getName(file);

		// build filePath
		var dirname = path.normalize(path.dirname(file)).split(/[/\\]/).pop(),
			collection = (dirname !== options.keys.views) ? dirname : '',
			filePath = path.normalize(path.join(options.dest, collection, path.basename(file)));

		// get page gray matter and content
		var pageMatter = getMatter(file),
			pageContent = pageMatter.content;

		if (collection) {
			pageMatter.data.baseurl = '../';
		}

		// template using Handlebars
		var source = wrapPage(pageContent, assembly.layouts[pageMatter.data.layout || options.layout]),
			context = buildContext(pageMatter.data),
			template = Handlebars.compile(source);

		// redefine file path if dest front-matter variable is defined
		if (pageMatter.data.dest) {
			filePath = path.normalize(pageMatter.data.dest);
		}

		// change extension to .html
		filePath = filterName(filePath.replace(/\.[0-9a-z]+$/, '.html'));

		// write file
		mkdirp.sync(path.dirname(filePath));
		fs.writeFileSync(filePath, template(context));

		// write a copy file if custom dest-copy front-matter variable is defined
		if (pageMatter.data['dest-copy']) {
			var copyPath = filterName(path.normalize(pageMatter.data['dest-copy']));
			mkdirp.sync(path.dirname(copyPath));
			fs.writeFileSync(copyPath, template(context));
		}
	});

};


/**
 * Module exports
 * @return {Object} Promise
 */
module.exports = function (userOptions) {

	try {

		// setup assembly
		setup(userOptions);

		// assemble
		assemble();

    // delete modular css + js from catch-all folders
    try {

      rmdir(path.normalize(path.join(options.dest, "assets", "toolkit", "styles",  "bundles")), function (e) {});
      rmdir(path.normalize(path.join(options.dest, "assets", "toolkit", "scripts", "bundles")), function (e) {});

    } catch (e) { console.log(e); }

	} catch(e) {
		handleError(e);
	}

};
