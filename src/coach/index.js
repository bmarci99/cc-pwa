// On-device chess coach: a faithful JS port of chess_analyzer/{analyze,coach,strategy,options}.py.
//
//   import { createEngine } from '../engine.js';
//   import { explainMove, insight, analyseGame, positionJson } from './coach/index.js';
//   const engine = await createEngine();
//   const info = await explainMove(engine, { fen: 'startpos', moves: ['e2e4'], uci: 'e7e5' });
export { explainMove, isCorrectSolution, explainMoveBoard, opponentThreat, parseMove, TIPS, VALUES, NAMES,
         hangingPieces, forkTargets, pinnedPieces, trappedPieces, describe, isHanging, mateIn, lineSan } from './coach.js';
export { insight, insightBoard, lastMoveInsight, tacticalScan, classifyStructure, imbalances, bigGoal, planInWords, see,
         outposts, pawnStructure, kingSafety, openFiles, development, space, badBishops, worstPiece, mobility, phase,
         evalWords, nullAnalysis } from './strategy.js';
export { buildOptions, safe, movesAttacking, backwardPawns } from './options.js';
export { analyseGame, parsePgn, winPct, classify, phaseOf, materialAnalyze as material } from './analyze.js';
export { positionJson, positionJsonBoard } from './position.js';
export { Board, boardFrom, moveFromUci, moveUci, squareName, parseSquare, WHITE, BLACK } from './board.js';
export { PySet } from './pyset.js';
export { createEngine, scoreOf, MATE, DEFAULT_NODES } from '../engine.js';
