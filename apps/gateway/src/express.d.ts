import type { Role } from "./repo.js";

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        email: string;
        name: string;
        role: Role;
      };
      apiKeyId?: string;
    }
  }
}

export {};
