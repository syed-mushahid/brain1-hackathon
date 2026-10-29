// Prints src/game/model.config.ts as JSON, so the Python scripts use the game's own numbers.
import { MODEL } from '../src/game/model.config'

console.log(JSON.stringify(MODEL))
