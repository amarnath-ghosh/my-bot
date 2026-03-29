// Load environment variables early before other imports
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.join(__dirname, "../../../.env.local") });
dotenv.config({ path: path.join(__dirname, "../../../.env") });
