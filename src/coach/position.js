// Port of server.position_json: game state for the UI (claim_draw=True: threefold / 50-move end the game).
import { boardFrom, moveUci } from './board.js';

const REASONS = {
  checkmate: 'checkmate', stalemate: 'stalemate', insufficient_material: 'insufficient material',
  seventyfive_moves: '75-move rule', fivefold_repetition: 'fivefold repetition',
  fifty_moves: '50-move rule', threefold_repetition: 'threefold repetition',
};

export function positionJsonBoard(b) {
  const outcome = b.outcome(true);
  return {
    fen: b.fen(), turn: b.turn ? 'white' : 'black',
    legal: outcome ? [] : b.legalMoves().map(moveUci), check: b.isCheck(),
    game_over: outcome !== null, result: outcome ? outcome.result : null,
    reason: outcome ? (REASONS[outcome.termination] ?? outcome.termination) : null,
    last_move: b.moveStack.length ? moveUci(b.peek()) : null,
  };
}

export function positionJson(fen = 'startpos', moves = []) {
  return positionJsonBoard(boardFrom(fen, moves));
}
