// Graph overlay (rendering, legend, refresh).
//
// Split out of the former monolith src/main.js; noteApp() in main.js composes
// this factory's object with the other feature slices (see compose()).

import * as api from '../core/api.js';

export function createGraph() {
    return {
        
        // ==================== GRAPH VIEW ====================
        
        // Initialize the graph visualization
        async initGraph() {
            this.graphError = '';
            this.graphEmpty = false;

            // vis-network (~700 KB) is fetched on first open of the graph
            // overlay — most sessions never open the graph at all.
            if (typeof vis === 'undefined') {
                if (!this._visLoadPromise) {
                    this._visLoadPromise = new Promise((resolve, reject) => {
                        const s = document.createElement('script');
                        s.src = '/static/vendor/vis-network/vis-network.min.js';
                        s.onload = resolve;
                        s.onerror = reject;
                        document.head.appendChild(s);
                    });
                    this._visLoadPromise.catch(() => {
                        this._visLoadPromise = null; // let the next open retry
                    });
                }
                try {
                    await this._visLoadPromise;
                } catch (e) {
                    console.error('vis-network failed to load:', e);
                    this._graphFail('graph.load_library_failed');
                    return;
                }
                if (typeof vis === 'undefined') {
                    console.error('vis-network library not loaded');
                    this._graphFail('graph.load_library_failed');
                    return;
                }
            }
            
            const requestId = (this._graphRequestId || 0) + 1;
            this._graphRequestId = requestId;
            this.graphLoaded = false;
            
            try {
                // Full map by default. The sidebar toggle asks the server to
                // leave out notes stored under any folder whose name starts with "_".
                const graphUrl = this.hideUnderscoreFolders
                    ? '/api/graph?include_system_folders=false'
                    : '/api/graph';
                // A stale response is discarded by requestId below, so no throw here.
                const response = await api.raw(graphUrl);
                if (requestId !== this._graphRequestId) return;
                if (!response.ok) throw new Error('Failed to fetch graph data');
                const data = await response.json();
                if (requestId !== this._graphRequestId) return;
                this.graphData = data;
                
                // Get container
                const container = document.getElementById('graph-overlay');
                if (!container) { this.graphLoaded = true; return; }
                
                // Nothing to draw: vis-network never emits
                // "stabilizationIterationsDone" with zero nodes, so the
                // spinner would spin forever without this early exit.
                const graphNodes = Array.isArray(data.nodes) ? data.nodes : [];
                if (graphNodes.length === 0) {
                    this.graphEmpty = true;
                    this.graphLoaded = true;
                    return;
                }
                
                // Get theme colors (force reflow to ensure CSS is applied)
                document.body.offsetHeight; // Force reflow
                const style = getComputedStyle(document.documentElement);
                
                // Helper to get CSS variable with fallback
                const getCssVar = (name, fallback) => {
                    const value = style.getPropertyValue(name).trim();
                    return value || fallback;
                };
                
                const accentPrimary = getCssVar('--accent-primary', '#7c3aed');
                const accentSecondary = getCssVar('--accent-secondary', '#a78bfa');
                const textPrimary = getCssVar('--text-primary', '#111827');
                const textSecondary = getCssVar('--text-secondary', '#6b7280');
                const bgPrimary = getCssVar('--bg-primary', '#ffffff');
                const bgSecondary = getCssVar('--bg-secondary', '#f3f4f6');
                const borderColor = getCssVar('--border-primary', '#e5e7eb');
                
                // Prepare nodes with styling - all nodes same base color
                const nodes = new vis.DataSet(graphNodes.map(n => ({
                    id: n.id,
                    label: n.label,
                    title: n.id, // Tooltip shows full path
                    color: {
                        background: accentPrimary,
                        border: accentPrimary,
                        highlight: {
                            background: accentPrimary,
                            border: textPrimary  // Darker border when selected
                        },
                        hover: {
                            background: accentSecondary,
                            border: accentPrimary
                        }
                    },
                    font: {
                        color: textPrimary,
                        size: 12,
                        face: 'system-ui, -apple-system, sans-serif'
                    },
                    borderWidth: this.currentNote === n.id ? 4 : 2,
                    chosen: {
                        node: (values) => {
                            values.size = 22;
                            values.borderWidth = 4;
                            values.borderColor = textPrimary;
                        }
                    }
                })));
                
                // Prepare edges with styling based on type
                const graphEdges = Array.isArray(data.edges) ? data.edges : [];
                const edges = new vis.DataSet(graphEdges.map((e, i) => ({
                    id: i,
                    from: e.source,
                    to: e.target,
                    color: {
                        color: e.type === 'wikilink' ? accentPrimary : borderColor,
                        highlight: accentPrimary,
                        hover: accentSecondary,
                        opacity: 0.8
                    },
                    width: e.type === 'wikilink' ? 2 : 1,
                    smooth: {
                        type: 'continuous',
                        roundness: 0.5
                    },
                    chosen: {
                        edge: (values) => {
                            values.width = 3;
                            values.color = accentPrimary;
                        }
                    }
                })));
                
                // Network options
                const options = {
                    nodes: {
                        shape: 'dot',
                        size: 16,
                        borderWidth: 2,
                        shadow: {
                            enabled: true,
                            color: 'rgba(0,0,0,0.1)',
                            size: 5,
                            x: 2,
                            y: 2
                        }
                    },
                    edges: {
                        arrows: {
                            to: {
                                enabled: true,
                                scaleFactor: 0.5,
                                type: 'arrow'
                            }
                        }
                    },
                    physics: {
                        enabled: true,
                        solver: 'forceAtlas2Based',
                        forceAtlas2Based: {
                            gravitationalConstant: -50,
                            centralGravity: 0.01,
                            springLength: 100,
                            springConstant: 0.08,
                            damping: 0.4,
                            avoidOverlap: 0.5
                        },
                        stabilization: {
                            enabled: true,
                            iterations: 200,
                            updateInterval: 25
                        }
                    },
                    interaction: {
                        hover: true,
                        tooltipDelay: 200,
                        navigationButtons: false,  // Using custom buttons instead
                        keyboard: {
                            enabled: true,
                            bindToWindow: false
                        },
                        zoomView: true,
                        dragView: true
                    },
                    layout: {
                        improvedLayout: true,
                        randomSeed: 42
                    }
                };
                
                // Destroy existing instance if any
                if (this.graphInstance) {
                    this.graphInstance.destroy();
                    this.graphInstance = null;
                }
                
                // Clear container to ensure clean state
                const graphCanvas = container.querySelector('canvas');
                if (graphCanvas) graphCanvas.remove();
                const visElements = container.querySelectorAll('.vis-network, .vis-navigation');
                visElements.forEach(el => el.remove());
                
                // Create the network
                this.graphInstance = new vis.Network(container, { nodes, edges }, options);
                
                // Store reference for callbacks
                const graphRef = this.graphInstance;
                const currentNoteRef = this.currentNote;
                
                // Hide the spinner exactly once, whenever stabilization ends.
                let finished = false;
                let safetyTimer = null;
                const finishGraphLoad = () => {
                    if (finished) return;
                    finished = true;
                    if (safetyTimer) clearTimeout(safetyTimer);
                    if (requestId !== this._graphRequestId) return;
                    
                    try {
                        graphRef.setOptions({ physics: { enabled: false } });
                    } catch (e) {
                        // Graph may already have been destroyed
                    }
                    this.graphLoaded = true;
                    
                    // Focus and select current note if one is loaded
                    if (currentNoteRef) {
                        setTimeout(() => {
                            try {
                                if (graphRef && this.showGraph) {
                                    const nodeIds = graphRef.body.data.nodes.getIds();
                                    if (nodeIds.includes(currentNoteRef)) {
                                        // Focus on the node
                                        graphRef.focus(currentNoteRef, {
                                            scale: 1.2,
                                            animation: {
                                                duration: 500,
                                                easingFunction: 'easeInOutQuad'
                                            }
                                        });
                                        // Select the node to highlight it
                                        graphRef.selectNodes([currentNoteRef]);
                                    }
                                }
                            } catch (e) {
                                // Ignore - graph may have been destroyed
                            }
                        }, 150);
                    }
                };
                
                // "stabilizationIterationsDone" is the normal path, but
                // vis-network can skip it entirely (0 nodes, a physics pass
                // that never settles, …). Without this fallback the overlay
                // would show "Loading graph..." forever.
                safetyTimer = setTimeout(finishGraphLoad, 10000);
                this.graphInstance.once('stabilizationIterationsDone', finishGraphLoad);
                this.graphInstance.once('stabilized', finishGraphLoad);
                
                // Click event - open note
                this.graphInstance.on('click', (params) => {
                    if (params.nodes.length > 0) {
                        const noteId = params.nodes[0];
                        this.loadNote(noteId);
                        // Node is already selected by vis-network on click, no need to call selectNodes
                    }
                });
                
                // Double-click event - open note and close graph
                this.graphInstance.on('doubleClick', (params) => {
                    if (params.nodes.length > 0) {
                        const noteId = params.nodes[0];
                        // Close graph and load note
                        this.showGraph = false;
                        this.loadNote(noteId);
                    }
                });
                
                // Hover event - highlight connections
                this.graphInstance.on('hoverNode', (params) => {
                    const nodeId = params.node;
                    const connectedNodes = this.graphInstance.getConnectedNodes(nodeId);
                    const connectedEdges = this.graphInstance.getConnectedEdges(nodeId);
                    
                    // Dim all nodes except hovered and connected
                    const allNodes = nodes.getIds();
                    const updates = allNodes.map(id => ({
                        id,
                        opacity: (id === nodeId || connectedNodes.includes(id)) ? 1 : 0.2
                    }));
                    nodes.update(updates);
                });
                
                this.graphInstance.on('blurNode', () => {
                    // Reset all nodes to full opacity
                    const allNodes = nodes.getIds();
                    const updates = allNodes.map(id => ({ id, opacity: 1 }));
                    nodes.update(updates);
                });
                
                // Add legend to container
                this.addGraphLegend(container, accentPrimary, borderColor, textSecondary);
                
            } catch (error) {
                if (requestId !== this._graphRequestId) return;
                console.error('Failed to initialize graph:', error);
                this._graphFail('graph.load_failed');
            }
        },
        
        // Stop the overlay spinner and surface a message instead of failing
        // silently (a bare console.error left "Loading graph..." up forever).
        _graphFail(messageKey) {
            this.graphLoaded = true;
            this.graphError = this.t(messageKey);
        },
        
        // Add legend to graph container
        addGraphLegend(container, wikiColor, mdColor, textColor) {
            // Remove existing legend if any
            const existingLegend = container.querySelector('.graph-legend');
            if (existingLegend) existingLegend.remove();
            
            const legend = document.createElement('div');
            legend.className = 'graph-legend';
            legend.innerHTML = `
                <div class="graph-legend-item">
                    <span class="graph-legend-dot" style="background: ${wikiColor};"></span>
                    <span style="color: ${textColor};">Wikilinks</span>
                </div>
                <div class="graph-legend-item">
                    <span class="graph-legend-dot" style="background: ${mdColor};"></span>
                    <span style="color: ${textColor};">${this.t('graph.markdown_links')}</span>
                </div>
                <div style="margin-top: 8px; font-size: 10px; color: ${textColor}; opacity: 0.7;">
                    ${this.t('graph.click_hint')}
                </div>
            `;
            container.appendChild(legend);
        },
        
        // Refresh graph when theme changes
        refreshGraph() {
            // The graph lives in its own overlay (showGraph), not in viewMode —
            // the old `viewMode === 'graph'` test was never true, so themes
            // never re-rendered the map.
            if (this.showGraph) {
                this.initGraph();
            }
        }
    };
}
