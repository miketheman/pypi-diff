// Module worker: diffing a large file here keeps the page responsive.
import { computeDiff } from './diff.js';

onmessage = e => postMessage(computeDiff(e.data.textA, e.data.textB));
