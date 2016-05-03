define(['events/events', 'message'], function(Events, Message) {

      // Number of search results to fetch
  var SEARCH_RESULT_ROWS = 40,

      NUM_TIME_HISTOGRAM_BINS = 34,

      // TODO we'll want to make these configurable through UI later
      FACET_FIELDS = [
        'Category',
        'Type',
        'FormatStatus',
        'Temporal',
        'Material'
      ],

      // TODO make this configurable, too
      BASE_PATH = 'http://localhost:8983/solr/peripleo/query';

  var SOLR = function(eventBroker) {

        /** search param state **/
    var searchParams =  {

          query: false,

          facetFilters: [],

          from: false,

          to: false

        },

        mergeParams = function(diff) {
          if ('query' in diff) {
            searchParams.query = diff.query;
          }

          if ('from' in diff || 'to' in diff) {
            searchParams.from = diff.from;
            searchParams.to = diff.to;
          }

          if ('facetFilter' in diff) {
            var previousFilter = jQuery.grep(searchParams.facetFilters, function(filter) {
                  return filter.facetField === diff.facetFilter.facetField;
                }),

                previousFilterIdx = (previousFilter.length > 0) ?
                  searchParams.facetFilters.indexOf(previousFilter[0]) :
                  -1;

            // Remove previous filter setting, if any
            if (previousFilterIdx > -1)
              searchParams.facetFilters.splice(previousFilterIdx, 1);

            if (diff.facetFilter.values) // If values is falsy, we want the filter cleared
              searchParams.facetFilters.push(diff.facetFilter);
          }
        },

        /** Base URL captures commmon params for 'standard' and histogram request **/
        buildBaseURL = function(rows, offset) {
          // TODO we don't need q.alt in case searchParams.query is defined I guess
          var url = BASE_PATH + '?defType=edismax&mm=100%25&q.alt=*:*&rows=' + rows,
              showOnlyFilterClauses = [],
              excludeFilterClauses = [];

          if (offset)
            url += '&start=' + offset;

          if (searchParams.query)
            url += '&q=' + searchParams.query;

          if (searchParams.facetFilters.length > 0) {
            // Collect all 'SHOW_ONLY' clauses
            jQuery.each(searchParams.facetFilters, function(i, filter) {
              if (filter.filterMode === 'SHOW_ONLY') {
                jQuery.each(filter.values, function(j, value) {
                  showOnlyFilterClauses.push(filter.facetField + ':' + encodeURIComponent('"' + value + '"'));
                });
              }
            });

            // Collect all 'EXCLUDE' clauses
            jQuery.each(searchParams.facetFilters, function(i, filter) {
              if (filter.filterMode === 'EXCLUDE') {
                jQuery.each(filter.values, function(j, value) {
                  excludeFilterClauses.push(filter.facetField + ':' + encodeURIComponent('"' + value + '"'));
                });
              }
            });

            if (showOnlyFilterClauses.length > 0)
              url += '&fq=' + showOnlyFilterClauses.join(' OR ');

            if (excludeFilterClauses.length > 0)
              url += '&fq=NOT (' + excludeFilterClauses.join(' OR ') + ')';
          }

          return url;
        },

        /** Normal search request is base URL plus time filter, field facets and timespan stats **/
        buildSearchRequestURL = function(offset) {
          var timeFilterClauses = [],
              url = buildBaseURL(SEARCH_RESULT_ROWS, offset);

          // Time filter
          if (searchParams.from)
            timeFilterClauses.push('TemporalLatest:[' + searchParams.from + ' TO *]');

          if (searchParams.to)
            timeFilterClauses.push('TemporalEarliest:[* TO ' + searchParams.to + ']');

          if (timeFilterClauses.length > 0)
            url += '&fq={!tag=time}' + timeFilterClauses.join(' AND ');

          // Field facets
          url += '&facet=true' +
            jQuery.map(FACET_FIELDS, function(field) {
              return '&facet.field=' + field;
            }).join('');

          // Stats (with time filter excluded)
          // TODO only add the {!ex=time} exclude if the time filter is actually set!
          return url +
            '&stats=true&stats.field={!ex=time}TemporalEarliest' +
            '&stats.field={!ex=time}TemporalLatest';
        },

        /** Histogram request is base URL plus time facet params **/
        buildHistogramRequestURL = function(startYear, endYear) {
          var start = startYear + '-01-01T00:00:00Z',
              end = endYear + '-12-31T23:59:59Z',
              gap;

          // Goal is 35 bins (for no other reason than aesthetics). But don't go
          // below 1 bin = 1 year. In this case we rather want fewer bars.
          gap = Math.round((endYear - startYear) / NUM_TIME_HISTOGRAM_BINS);
          if (gap < 1)
            gap = 1;

          return buildBaseURL(0) + '&facet=true' +
                 '&facet.range=TemporalUTC' +
                 '&facet.range.start=' + start +
                 '&facet.range.end=' + end +
                 '&facet.range.gap=%2B' + gap + 'YEARS';
        },

        /** Issues a standard search request **/
        makeSearchRequest = function(offset) {
          return jQuery.getJSON(buildSearchRequestURL(offset))
            .fail(function(error) {
              console.log(error);
              Message.error('No connection to SOLR backend.');
            });
        },

        /**
         * Builds the time histogram through a sequence of two requests:
         * - the first request fetches min/max years using SOLR stats
         * - the second requests retrieves the date range facets based for the min/max interval
         */
        makeHistogramRequest = function(stats) {
          var fieldEarliest = stats.stats_fields.TemporalEarliest,
              fieldLatest = stats.stats_fields.TemporalLatest,
              earliest = Math.min(fieldEarliest.min, fieldLatest.min),
              latest = Math.max(fieldEarliest.max, fieldLatest.max);

          // Only fetch the histogram if there is an interval
          // Note: an undated response will result in earliest = latest = 0
          if (earliest !== latest) {
            jQuery.getJSON(buildHistogramRequestURL(earliest, latest))
              .done(function(response) {
                eventBroker.fireEvent(Events.SOLR_TIME_HISTOGRAM, response);
              })
              .fail(function(error) {
                // Not fatal - just log
                console.log(error);
              });
          }
        };

    eventBroker.addHandler(Events.SEARCH_CHANGED, function(diff) {
      mergeParams(diff);

      // TODO introduce idle time, buffer changes, and fire max one request every N milliseconds

      makeSearchRequest().done(function(response) {
        // TODO don't fetch histogram if the diff only affected the time filter
        makeHistogramRequest(response.stats);
        eventBroker.fireEvent(Events.SOLR_SEARCH_RESPONSE, response);
      });
    });

    eventBroker.addHandler(Events.LOAD_NEXT_PAGE, function(offset) {
      makeSearchRequest(offset).done(function(response) {
        eventBroker.fireEvent(Events.SOLR_NEXT_PAGE, response);
      });
    });

  };

  return SOLR;

});
