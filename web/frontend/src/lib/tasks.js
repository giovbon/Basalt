// GFM task list scanning and toggling.
//
// The preview renders one <li> per task and stamps each checkbox with a
// data-task-index; these helpers map that index back to a source line so a
// click edits exactly the line it came from (and never a lookalike in a code
// fence or frontmatter).

/** GFM task item as (everything up to `[`)(state). Literal spaces around the
 *  brackets, not \s, because that is what marked requires; the leading chain covers
 *  containers opened on the same line, e.g. `- > - [ ] x`, which marked does render.
 *  Missing a task marked renders is the one unsafe direction: see scanTaskLines. */
export const TASK_ITEM_RE = /^(\s*(?:(?:[-*+]|\d{1,9}[.)]) +|>\s*)*(?:[-*+]|\d{1,9}[.)]) +\[)([ xX])(?=\] )/;

const FENCE_RE = /^\s*(`{3,}|~{3,})/;

/** Indexes (0-based) of the lines that are tasks, skipping frontmatter and fences. */
export function scanTaskLines(source) {
    if (typeof source !== 'string' || !source) return [];
    const lines = source.split('\n');
    const taskLines = [];
    let startIdx = 0;

    if (lines[0] && lines[0].trim() === '---') {
        for (let i = 1; i < lines.length; i++) {
            if (lines[i].trim() === '---') {
                startIdx = i + 1;
                break;
            }
        }
    }

    // Indented fences count here: one nested in a list item still hides tasks.
    let openFence = null;

    for (let i = startIdx; i < lines.length; i++) {
        const fence = lines[i].match(FENCE_RE);
        if (openFence) {
            if (fence && fence[1][0] === openFence[0] && fence[1].length >= openFence.length) {
                openFence = null;
            }
            continue;
        }
        if (fence) {
            openFence = fence[1];
            continue;
        }
        if (TASK_ITEM_RE.test(lines[i])) taskLines.push(i);
    }

    return taskLines;
}

/**
 * Toggle the task at `index` (its position among tasks, not its line).
 *
 * @returns {{ found: boolean, changed: boolean, lineIndex: number,
 *             oldLine: string, newLine: string, text: string }}
 */
export function toggleTaskAt(source, index) {
    const lineIndex = scanTaskLines(source)[index];
    if (lineIndex === undefined) {
        return { found: false, changed: false, lineIndex: -1, oldLine: '', newLine: '', text: source };
    }

    const lines = source.split('\n');
    const oldLine = lines[lineIndex];
    const newLine = oldLine.replace(
        TASK_ITEM_RE,
        (match, prefix, state) => prefix + (state === ' ' ? 'x' : ' ')
    );
    if (newLine === oldLine) {
        return { found: true, changed: false, lineIndex, oldLine, newLine, text: source };
    }

    lines[lineIndex] = newLine;
    return { found: true, changed: true, lineIndex, oldLine, newLine, text: lines.join('\n') };
}

/**
 * Set every task to the opposite state of the task at `index`.
 *
 * Used by Ctrl+click. Returns the new text in one piece, so the caller can
 * assign it once and let the browser undo the whole change in one step.
 *
 * @returns {{ found: boolean, changed: boolean, text: string,
 *             nextState: ' '|'x'|null, total: number, changeCount: number }}
 */
export function setAllTasks(source, index) {
    const taskLines = scanTaskLines(source);
    const clickedLine = taskLines[index];
    if (clickedLine === undefined) {
        return { found: false, changed: false, text: source, nextState: null, total: taskLines.length, changeCount: 0 };
    }

    const lines = source.split('\n');
    const clicked = lines[clickedLine].match(TASK_ITEM_RE);
    if (!clicked) {
        return { found: false, changed: false, text: source, nextState: null, total: taskLines.length, changeCount: 0 };
    }

    // Intent comes from the source, not the DOM: clicking the box has already
    // flipped the input, clicking the text next to it has not.
    const nextState = clicked[2] === ' ' ? 'x' : ' ';
    let changeCount = 0;

    for (const lineIdx of taskLines) {
        const updated = lines[lineIdx].replace(TASK_ITEM_RE, (match, prefix) => prefix + nextState);
        if (updated !== lines[lineIdx]) {
            lines[lineIdx] = updated;
            changeCount++;
        }
    }

    return {
        found: true,
        changed: changeCount > 0,
        text: changeCount > 0 ? lines.join('\n') : source,
        nextState,
        total: taskLines.length,
        changeCount,
    };
}
