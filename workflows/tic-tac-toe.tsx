/** @jsxImportSource smithers */
import { createSmithers, GeminiAgent, Sequence, Ralph } from "smithers";
import { z } from "zod";

// --- Schemas ---

const moveSchema = z.object({
  row: z.number().int().min(0).max(2),
  col: z.number().int().min(0).max(2),
});

const gameStateSchema = z.object({
  board: z.string(),
  currentPlayer: z.enum(["X", "O"]),
  lastMove: z.string().optional(),
  winner: z.string().optional(),
  isDraw: z.boolean(),
  gameOver: z.boolean(),
});

// --- Smithers setup ---

const { Workflow, Task, smithers, outputs } = createSmithers({
  move: moveSchema,
  gameState: gameStateSchema,
});

// --- Agents ---

const playerX = new GeminiAgent({
  model: "gemini-2.5-flash",
  yolo: true,
  systemPrompt: `You are playing Tic Tac Toe as player X. You will be given the current board state.
Pick the best available move. Return ONLY a JSON object with "row" and "col" (0-indexed, 0-2).
Example: {"row": 1, "col": 2}
Do NOT include any other text.`,
});

const playerO = new GeminiAgent({
  model: "gemini-2.5-flash",
  yolo: true,
  systemPrompt: `You are playing Tic Tac Toe as player O. You will be given the current board state.
Pick the best available move. Return ONLY a JSON object with "row" and "col" (0-indexed, 0-2).
Example: {"row": 0, "col": 0}
Do NOT include any other text.`,
});

// --- Board helpers ---

function emptyBoard(): string[][] {
  return [
    [".", ".", "."],
    [".", ".", "."],
    [".", ".", "."],
  ];
}

function parseBoard(boardStr: string): string[][] {
  if (!boardStr) return emptyBoard();
  try {
    const parsed = JSON.parse(boardStr);
    if (Array.isArray(parsed) && parsed.length === 3) return parsed;
  } catch {}
  return emptyBoard();
}

function boardToString(board: string[][]): string {
  return JSON.stringify(board);
}

function formatBoard(board: string[][]): string {
  return board.map((row) => row.join(" | ")).join("\n---------\n");
}

function checkWinner(board: string[][]): string | undefined {
  for (let r = 0; r < 3; r++) {
    if (board[r][0] !== "." && board[r][0] === board[r][1] && board[r][1] === board[r][2])
      return board[r][0];
  }
  for (let c = 0; c < 3; c++) {
    if (board[0][c] !== "." && board[0][c] === board[1][c] && board[1][c] === board[2][c])
      return board[0][c];
  }
  if (board[0][0] !== "." && board[0][0] === board[1][1] && board[1][1] === board[2][2])
    return board[0][0];
  if (board[0][2] !== "." && board[0][2] === board[1][1] && board[1][1] === board[2][0])
    return board[0][2];
  return undefined;
}

function isFull(board: string[][]): boolean {
  return board.every((row) => row.every((cell) => cell !== "."));
}

// --- Workflow ---

export default smithers((ctx) => {
  // Get the latest game state from previous iterations
  const latestState = ctx.latest("gameState", "update-state");
  const board = latestState ? parseBoard(latestState.board) : emptyBoard();
  const currentPlayer: "X" | "O" = latestState?.currentPlayer ?? "X";
  const gameOver = latestState?.gameOver ?? false;

  const agent = currentPlayer === "X" ? playerX : playerO;

  return (
    <Workflow name="tic-tac-toe">
      <Ralph until={gameOver} maxIterations={9} onMaxReached="return-last">
        <Sequence>
          <Task id="make-move" output={outputs.move} agent={agent}>
            {`You are player ${currentPlayer}. Here is the current board:

${formatBoard(board)}

Available positions (row, col): ${board
              .flatMap((row, r) =>
                row.map((cell, c) => (cell === "." ? `(${r},${c})` : null)).filter(Boolean),
              )
              .join(", ")}

Pick an open position. Return ONLY JSON: {"row": <0-2>, "col": <0-2>}`}
          </Task>
          <Task id="update-state" output={outputs.gameState}>
            {(() => {
              const move = ctx.outputMaybe("move", { nodeId: "make-move" });
              if (!move) {
                return {
                  board: boardToString(board),
                  currentPlayer,
                  gameOver: false,
                  isDraw: false,
                };
              }
              const newBoard = board.map((row) => [...row]);
              if (
                move.row >= 0 && move.row <= 2 &&
                move.col >= 0 && move.col <= 2 &&
                newBoard[move.row][move.col] === "."
              ) {
                newBoard[move.row][move.col] = currentPlayer;
              }
              const w = checkWinner(newBoard);
              const draw = !w && isFull(newBoard);
              const nextPlayer = currentPlayer === "X" ? "O" : "X";
              return {
                board: boardToString(newBoard),
                currentPlayer: w || draw ? currentPlayer : nextPlayer,
                lastMove: `${currentPlayer} played (${move.row}, ${move.col})`,
                winner: w,
                isDraw: draw,
                gameOver: !!w || draw,
              };
            })()}
          </Task>
        </Sequence>
      </Ralph>
    </Workflow>
  );
});
