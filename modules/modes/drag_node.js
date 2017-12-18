import {
    event as d3_event,
    select as d3_select
} from 'd3-selection';

import { t } from '../util/locale';

import {
    actionAddMidpoint,
    actionConnect,
    actionMoveNode,
    actionNoop
} from '../actions';

import {
    behaviorEdit,
    behaviorHover,
    behaviorDrag
} from '../behavior';

import {
    modeBrowse,
    modeSelect
} from './index';

import { geoChooseEdge, geoViewportEdge } from '../geo';
import { osmNode } from '../osm';
import { utilEntitySelector } from '../util';
import { uiFlash } from '../ui';


export function modeDragNode(context) {
    var mode = {
        id: 'drag-node',
        button: 'browse'
    };
    var hover = behaviorHover(context).altDisables(true).on('hover', context.ui().sidebar.hover);
    var edit = behaviorEdit(context);

    var _nudgeInterval;
    var _restoreSelectedIDs = [];
    var _activeIDs = [];
    var _wasMidpoint = false;
    var _isCancelled = false;
    var _dragEntity;
    var _lastLoc;


    function vecSub(a, b) {
        return [a[0] - b[0], a[1] - b[1]];
    }


    function startNudge(entity, nudge) {
        if (_nudgeInterval) window.clearInterval(_nudgeInterval);
        _nudgeInterval = window.setInterval(function() {
            context.pan(nudge);
            doMove(entity, nudge);
        }, 50);
    }


    function stopNudge() {
        if (_nudgeInterval) {
            window.clearInterval(_nudgeInterval);
            _nudgeInterval = null;
        }
    }


    function moveAnnotation(entity) {
        return t('operations.move.annotation.' + entity.geometry(context.graph()));
    }


    function connectAnnotation(entity) {
        return t('operations.connect.annotation.' + entity.geometry(context.graph()));
    }


    function origin(entity) {
        return context.projection(entity.loc);
    }


    function start(entity) {
        _wasMidpoint = entity.type === 'midpoint';
        var hasHidden = context.features().hasHiddenConnections(entity, context.graph());
        _isCancelled = d3_event.sourceEvent.shiftKey || hasHidden;


        if (_isCancelled) {
            if (hasHidden) {
                uiFlash().text(t('modes.drag_node.connected_to_hidden'))();
            }
            return behavior.cancel();
        }

        if (_wasMidpoint) {
            var midpoint = entity;
            entity = osmNode();
            context.perform(actionAddMidpoint(midpoint, entity));

            var vertex = context.surface().selectAll('.' + entity.id);
            behavior.target(vertex.node(), entity);

        } else {
            context.perform(actionNoop());
        }

        _dragEntity = entity;

        // `.active` elements have `pointer-events: none`.
        // This prevents the node or vertex being dragged from trying to connect to itself.
        _activeIDs = context.graph().parentWays(entity)
            .map(function(parent) { return parent.id; });
        _activeIDs.push(entity.id);
        setActiveElements();

        context.enter(mode);
    }


    function datum() {
        var event = d3_event && d3_event.sourceEvent;
        if (!event || event.altKey) {
            return {};
        } else {
            return event.target.__data__ || {};
        }
    }


    function doMove(entity, nudge) {
        nudge = nudge || [0, 0];

        var currPoint = (d3_event && d3_event.point) || context.projection(_lastLoc);
        var currMouse = vecSub(currPoint, nudge);
        var loc = context.projection.invert(currMouse);

        if (!_nudgeInterval) {
            // If we're not nudging at the edge of the viewport, try to snap..
            // See also `behavior/draw.js click()`
            var d = datum();

            // Snap to a node (not self)
            if (d.type === 'node' && d.id !== entity.id) {
                loc = d.loc;

            // Snap to a way (not an area fill)
            } else if (d.type === 'way' && !d3_select(d3_event.sourceEvent.target).classed('fill')) {

                // var childNodes = context.childNodes(d);
                // var childIDs = childNodes.map(function(node) { return node.id; });
                var choice = geoChooseEdge(context.childNodes(d), context.mouse(), context.projection);
                // (not along a segment adjacent to self)
                if (entity.id !== d.nodes[choice.index - 1] && entity.id !== d.nodes[choice.index]) {
                    loc = choice.loc;
                }
            }
        }

        context.replace(
            actionMoveNode(entity.id, loc),
            moveAnnotation(entity)
        );

        _lastLoc = loc;
    }


    function move(entity) {
        if (_isCancelled) return;

        d3_event.sourceEvent.stopPropagation();
        _lastLoc = context.projection.invert(d3_event.point);

        doMove(entity);
        var nudge = geoViewportEdge(d3_event.point, context.map().dimensions());
        if (nudge) {
            startNudge(entity, nudge);
        } else {
            stopNudge();
        }
    }


    function end(entity) {
        if (_isCancelled) return;

        var d = datum();

        if (d.type === 'way') {
            var choice = geoChooseEdge(context.childNodes(d), context.mouse(), context.projection);
            context.replace(
                actionAddMidpoint({ loc: choice.loc, edge: [d.nodes[choice.index - 1], d.nodes[choice.index]] }, entity),
                connectAnnotation(d)
            );

        } else if (d.type === 'node' && d.id !== entity.id) {
            context.replace(
                actionConnect([d.id, entity.id]),
                connectAnnotation(d)
            );

        } else if (_wasMidpoint) {
            context.replace(
                actionNoop(),
                t('operations.add.annotation.vertex')
            );

        } else {
            context.replace(
                actionNoop(),
                moveAnnotation(entity)
            );
        }

        var reselection = _restoreSelectedIDs.filter(function(id) {
            return context.graph().hasEntity(id);
        });

        if (reselection.length) {
            context.enter(modeSelect(context, reselection));
        } else {
            context.enter(modeBrowse(context));
        }
    }


    function cancel() {
        behavior.cancel();
        context.enter(modeBrowse(context));
    }


    function setActiveElements() {
        context.surface().selectAll(utilEntitySelector(_activeIDs))
            .classed('active', true);
    }


    var behavior = behaviorDrag()
        .selector('.layer-points-targets .target')
        .surface(d3_select('#map').node())
        .origin(origin)
        .on('start', start)
        .on('move', move)
        .on('end', end);


    mode.enter = function() {
        context.install(hover);
        context.install(edit);

        context.history()
            .on('undone.drag-node', cancel);

        context.map()
            .on('drawn.drag-node', setActiveElements);

        setActiveElements();
    };


    mode.exit = function() {
        context.ui().sidebar.hover.cancel();
        context.uninstall(hover);
        context.uninstall(edit);

        context.history()
            .on('undone.drag-node', null);

        context.map()
            .on('drawn.drag-node', null);

        context.surface()
            .selectAll('.active')
            .classed('active', false);

        stopNudge();
    };


    mode.selectedIDs = function() {
        if (!arguments.length) return _dragEntity ? [_dragEntity.id] : [];
        // no assign
        return mode;
    };


    mode.restoreSelectedIDs = function(_) {
        if (!arguments.length) return _restoreSelectedIDs;
        _restoreSelectedIDs = _;
        return mode;
    };


    mode.behavior = behavior;


    return mode;
}
