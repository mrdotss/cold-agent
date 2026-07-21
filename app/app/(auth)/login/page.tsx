import type { Metadata } from "next";

import { LoginForm } from "@/components/auth/login-form";

export const metadata: Metadata = {
  title: "Sign in · Cloud Bill Analyst",
};

/**
 * Public login page (Req 2.2, 2.3). Renders the client `LoginForm`, which is
 * wired to the `login` server action, inside the shared editorial auth layout.
 */
export default function LoginPage() {
  return <LoginForm />;
}
