import type { Metadata } from "next";

import { RegisterForm } from "@/components/auth/register-form";

export const metadata: Metadata = {
  title: "Create account · Cloud Bill Analyst",
};

/**
 * Public registration page (Req 1.1, 1.3, 1.4). Renders the client
 * `RegisterForm`, wired to the `registerUser` server action, inside the shared
 * editorial auth layout.
 */
export default function RegisterPage() {
  return <RegisterForm />;
}
