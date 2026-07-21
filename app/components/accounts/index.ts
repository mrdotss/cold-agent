/**
 * Account-wizard UI components (task 10.2).
 *
 * All components here are presentational client components. They receive any
 * server-generated data (External_Id, CloudFormation template, launch URL) as
 * props and talk to the server only through the account routes / server actions;
 * none of them import a `server-only` module. The `/accounts` page (task 10.3)
 * composes these into the full wizard flow.
 */
export { CopyButton, type CopyButtonProps } from "./copy-button";
export {
  RedactedError,
  type RedactedErrorProps,
  type ConnectionErrorCategory,
  CONNECTION_ERROR_MESSAGES,
} from "./redacted-error";
export { ExternalIdStep, type ExternalIdStepProps } from "./external-id-step";
export { CfnTemplateStep, type CfnTemplateStepProps } from "./cfn-template-step";
export {
  ConnectAccountForm,
  type ConnectAccountFormProps,
} from "./connect-account-form";
export {
  ConnectAccountWizard,
  type ConnectAccountWizardProps,
} from "./connect-account-wizard";
export { AccountSwitcher, type AccountSwitcherProps } from "./account-switcher";
export { AccountSettings, type AccountSettingsProps } from "./account-settings";
export {
  RemoveAccountDialog,
  type RemoveAccountDialogProps,
} from "./remove-account-dialog";
export { AccountList, type AccountListProps } from "./account-list";
export {
  AccountsManager,
  type AccountsManagerProps,
} from "./accounts-manager";
