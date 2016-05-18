var MAP; // the esri.Map object
var OVERLAY_TRAILS; // an ArcGIS Dynamic Service Layer showing the trails
var HIGHLIGHT_TRAIL; // Graphics layer showing a highlight on the selected trail, e.g. on clicking a trail
var HIGHLIGHT_MARKER; // Graphics layer showing a marker over the selected highlighted trail, e.g. on cursor movement over the elevation chart
var HIGHLIGHT_TRAIL_SYMBOL; // a symbol for the 1 Graphic that will be present in HIGHLIGHT_TRAIL
var HIGHLIGHT_MARKER_SYMBOL; // a symbol for the 1 Graphic that will be present in HIGHLIGHT_MARKER

var START_W = -106.88042;
var START_E = -106.79802;
var START_S =   39.16306;
var START_N =   39.22692;

var ARCGIS_URL = "http://maps.pitkincounty.com/arcgis/rest/services/Projects/PO_OST_Layers/MapServer";
var LAYERID_TRAILS = 1;

var HIGHLIGHT_COLOR  = [255,  0,  0]; // when a trail segment is clicked and highlighted, what color highlight?
var HIGHLIGHT_COLOR2 = [255,  0,  0]; // when a trail's elevation profile is used, what color marker to indicate the location?


/********************************************************************
 * MAP INITIALIZATION
 * using the new 3.8 version, where require() takes a callback
 ********************************************************************/

esri.config.defaults.io.corsEnabledServers = [
    'sampleserver6.arcgisonline.com',
];

require([
    "esri/map", 
    "dojo/domReady!"
], function() {
    // the basic map
    MAP = new esri.Map("map", {
        extent: new esri.geometry.Extent({xmin:START_W,ymin:START_S,xmax:START_E,ymax:START_N,spatialReference:{wkid:4326}}),
        basemap: "streets"
    });

    // add the trails overlay to the map
    OVERLAY_TRAILS = new esri.layers.ArcGISDynamicMapServiceLayer(ARCGIS_URL);
    OVERLAY_TRAILS.setVisibleLayers([ LAYERID_TRAILS ]);
    MAP.addLayer(OVERLAY_TRAILS);

    // we'll want to highlight the trail, and to draw a marker linked to the chart; define those 2 graphics layers here
    // why not 1 layer with both graphics? easier to untangle this way, compraed to iterating over the features and finding which is the marker or line
    HIGHLIGHT_TRAIL  = new esri.layers.GraphicsLayer({ opacity:0.50 });
    HIGHLIGHT_MARKER = new esri.layers.GraphicsLayer();
    MAP.addLayer(HIGHLIGHT_TRAIL);
    MAP.addLayer(HIGHLIGHT_MARKER);

    // define this symbol, so we don't redefine it repeatedly at runtime
    // used to draw the red-n-black dot on the map as the user moves mouse over the chart
    var outline = new esri.symbol.SimpleLineSymbol(esri.symbol.SimpleLineSymbol.STYLE_SOLID, new dojo.Color([0,0,0]), 1);
    HIGHLIGHT_MARKER_SYMBOL = new esri.symbol.SimpleMarkerSymbol(esri.symbol.SimpleMarkerSymbol.STYLE_CIRCLE,10,outline,new dojo.Color(HIGHLIGHT_COLOR2) );

    // define this symbol, so we don't redefine it repeatedly at runtime
    // used to highlight a tasil in yellow when it has been clicked
    HIGHLIGHT_TRAIL_SYMBOL = new esri.symbol.SimpleLineSymbol(esri.symbol.SimpleLineSymbol.STYLE_SOLID, new dojo.Color(HIGHLIGHT_COLOR), 5);

    // on a map click, make a query for the trail and then for its elevation profile...
    dojo.connect(MAP, "onClick", function (event) {
        handleMapClick(event);
    });
}); // end of setup and map init



/********************************************************************
 * CLICK HANDLER
 ********************************************************************/


// handle a map click, by firing a Query
function handleMapClick(event) {
    // if the trails layer isn't in range, skip this
    if (! OVERLAY_TRAILS.visibleAtMapScale ) return;

    // compose the query: just the name field, and in this 50 meter "radius" from our click
    var query = new esri.tasks.Query();
    query.returnGeometry = true;
    query.outFields      = [ "NAME" ];
    query.geometry       = new esri.geometry.Extent({
        "xmin": event.mapPoint.x - 50,
        "ymin": event.mapPoint.y - 50,
        "xmax": event.mapPoint.x + 50,
        "ymax": event.mapPoint.y + 50,
        "spatialReference": event.mapPoint.spatialReference
    });

    var task = new esri.tasks.QueryTask(ARCGIS_URL + '/' + LAYERID_TRAILS );
    task.execute(query, function (featureSet) {
        handleMapClickResults(featureSet);
    });
}

// handle the Query result
function handleMapClickResults(features) {
    // start by clearing previous results
    HIGHLIGHT_TRAIL.clear();
    HIGHLIGHT_MARKER.clear();

    // grab the first hit; nothing found? bail
    if (! features.features.length) return;
    var feature = features.features[0];

    // highlight using the given vector geometry...
    HIGHLIGHT_TRAIL.add(feature);
    feature.setSymbol(HIGHLIGHT_TRAIL_SYMBOL);

    // fill in the name of the trail they clicked, is all
    $('#trail_name').text(feature.attributes.NAME);

    // now make the geoprocessing call to fetch the elevation info
    // there's only 1 param: a list of geometries; in our case the list is 1 item, that being the feature we got as a result
    var elevsvc = new esri.tasks.Geoprocessor("http://sampleserver6.arcgisonline.com/arcgis/rest/services/Elevation/WorldElevations/MapServer/exts/ElevationsSOE_NET/ElevationLayers/0/GetElevations");
    var params = { geometries:[ feature.geometry ] };
    elevsvc.submitJob(params, function (reply) {
        // success: grab the 1 path we were given back, convert it into chart-friendly points, then chart them
        var path;
        try {
            path = reply.geometries[0].paths[0];
        } catch(e) { alert("Elevation service didn't return an elevation profile."); }

        // HighCharts has a built-in setting turboThreshold to help performance in case someone accidentally submits a zillion points
        // for more info and to work around this:
        //      http://www.highcharts.com/errors/12
        //      http://api.highcharts.com/highcharts#plotOptions.series.turboThreshold
        if (path.length > 1000) return alert("Pick a shorter trail.");

        // two steps here: convert the path to points, then hand the points off for charting
        // general principle of separating into steps, so we can debug them or mess with them separately (e.g. some future change to massage the data or react to it)
        var points = makeElevationProfileFromPath(path);
        renderElevationProfileChart(points,'elevationgraph');
    }, function (status) {
        //console.log('status ping');
    }, function (error) {
        alert(error);
    });
}

// input: a Path given to us from the elevation service geoprocessor: a list of tuples, each one being X/Y/meters
// return: a list of points for charting and in USA units: { lon, lat, elevft, text, miles }
// this function does massaging to the input data, such as converting the elevation from meters to feet (we're in the USA)
// and adding up lengths to figure the distance traveled at the end of each segment; the length in miles is effectively the X axis of the chart
// added bonus: it also calculates the elevation delta from your start, which looks very good in tooltips
function makeElevationProfileFromPath(path) {
    // capture the elevation of the first node, so we can calculate elevation diffs for each point
    // e.g. "+23 ft from starting point"
    var start_elevft = Math.round(path[0][2] * 3.28084); // from meters to feet

    // create a list of points from the points given
    // keep a cumulative sum of distance traveled (meters) over segments so far; used to calculate "miles" as the X axis location for this node
    var points  = [];
    var total_m = 0;
    for (var i=0, l=path.length; i<l; i++) {
        var lon    = path[i][0];
        var lat    = path[i][1];
        var elevft = Math.round( path[i][2] * 3.28084 ); // from meters to feet

        // increment the total meters traveled when the hiker arrives at this node: that is, the distance from this node to the previous node
        // then express that as miles for the current node  (at this node, you have come X miles)
        if (i) {
            var plon = path[i-1][0];
            var plat = path[i-1][1];
            var slen = Math.sqrt( ((lon-plon)*(lon-plon)) + ((lat-plat)*(lat-plat)) );
            total_m += slen;
        }
        var miles  = 0.000621371 * total_m;

        // tooltip content: elevation is +- X feet relative to the starting node
        var delev  = Math.abs(start_elevft-elevft);
            delev = (elevft>=start_elevft ? '+' : '-') + delev;
        var text   = "Elevation: " + elevft + " ft" + "<br/>" + delev + " ft compared to start";

        // ready, stick it on
        points.push({ lon:lon, lat:lat, elevft:elevft, miles:miles, text:text });
    }

    // done!
    return points;
}

// given a set of chart-friendly points as returned from makeElevationProfileFromPath() plot it via Highcharts
// this is straightforward Highcharts charting, with the only interesting magic being the series.mouseOver effect
// as you mouse over the chart, the lat & lon are noted from the moused-over chart point, and HIGHLIGHT_MARKER moves on the map
function renderElevationProfileChart(points,containerid) {
    // massage it into the "x" and "y" structs expected by Highcharts: lon & lat are extraneous (used for mouseover), X and Y are the axis position and values, ...
    // also keep track of the lowest elevation found, acts as our 0 on the chart
    var lowest = 1000000;
    var data   = [];
    for (var i=0, l=points.length; i<l; i++) {
        data.push({ x:points[i].miles, y:points[i].elevft, name:points[i].text, lon:points[i].lon, lat:points[i].lat });
        if (points[i].elevft < lowest) lowest = points[i].elevft;
    }

    // render the given set of points from makeElevationProfileFromPath() into a Highcharts graph
    // the idea is that we want to reuse code between various types of linear features that may have elevation, so we don't hardcode element IDs into the lower-level functions, you see...
    var chart = new Highcharts.Chart({
        chart: {
            type: 'area',
            renderTo: containerid
        },
        title: {
            text: null
        },
        xAxis: {
            title: {
                text: 'Distance (mi)'
            }
        },
        yAxis: {
            title: {
                text: 'Elevation (ft)'
            },
            min:lowest,
            allowDecimals:false
        },
        legend: {
            enabled:false
        },
        tooltip: {
            crosshairs: [true,true],
            formatter: function () {
                return this.point.name;
            }
        },
        plotOptions: {
            area: {
                marker: {
                    enabled: false,
                    symbol: 'circle',
                    radius: 2,
                    states: {
                        hover: {
                            enabled: true
                        }
                    }
                }
            },
            series: {
                point: {
                    events: {
                        mouseOver: function() {
                            var point = new esri.geometry.Point(this.lon,this.lat,MAP.spatialReference);
                            if (HIGHLIGHT_MARKER.graphics.length) {
                                HIGHLIGHT_MARKER.graphics[0].setGeometry(point);
                            } else {
                                HIGHLIGHT_MARKER.add(new esri.Graphic(point,HIGHLIGHT_MARKER_SYMBOL));
                            }
                        }
                    }
                },
                events: {
                    mouseOut: function() {
                        HIGHLIGHT_MARKER.clear();
                    }
                }
            }
        },
        series: [{ name: 'Elevation', data: data }]
    });
}
