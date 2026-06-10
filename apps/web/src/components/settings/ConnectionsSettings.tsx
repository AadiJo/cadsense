import { BotIcon, ExternalLinkIcon, InfoIcon, PlusIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { MechbaseConnection, OnshapeConnection } from "@cadsense/contracts";

import { readEnvironmentApi } from "~/environmentApi";
import { usePrimaryEnvironmentId } from "~/environments/primary";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

const ITEM_ROW_CLASSNAME = "border-t border-border/60 px-4 py-4 first:border-t-0 sm:px-5";
const ITEM_ROW_INNER_CLASSNAME =
  "flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between";
const HEADER_ACTION_BUTTON_CLASSNAME =
  "h-5 gap-1 rounded-sm px-1 text-[11px] font-normal text-muted-foreground/60 hover:text-muted-foreground";

type ConnectionInfoDialogProps = {
  title: string;
  description: string;
  steps: ReadonlyArray<string>;
  links: ReadonlyArray<{
    label: string;
    href: string;
  }>;
};

function ConnectionInfoDialog({ title, description, steps, links }: ConnectionInfoDialogProps) {
  return (
    <Dialog>
      <DialogTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            className="size-5 rounded-sm text-sky-500 hover:bg-sky-500/10 hover:text-sky-400"
            aria-label={`${title} setup information`}
          >
            <InfoIcon className="size-3" />
          </Button>
        }
      />
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-5">
          <section className="space-y-2">
            <h3 className="text-xs font-medium text-foreground">Setup steps</h3>
            <ol className="list-decimal space-y-1.5 pl-4 text-sm text-muted-foreground">
              {steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </section>
          {links.length > 0 ? (
            <section className="space-y-2">
              <h3 className="text-xs font-medium text-foreground">Links</h3>
              <div className="flex flex-wrap gap-2">
                {links.map((link) => (
                  <Button
                    key={link.href}
                    size="xs"
                    variant="outline"
                    render={<a href={link.href} target="_blank" rel="noreferrer" />}
                  >
                    <ExternalLinkIcon className="size-3" />
                    {link.label}
                  </Button>
                ))}
              </div>
            </section>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Close</DialogClose>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

type OnshapeConnectionListRowProps = {
  connection: OnshapeConnection;
  onEdit: (connection: OnshapeConnection) => void;
  onDelete: (connection: OnshapeConnection) => void;
  isDeleting: boolean;
};

function OnshapeConnectionListRow({
  connection,
  onEdit,
  onDelete,
  isDeleting,
}: OnshapeConnectionListRowProps) {
  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-2">
            <img src="/onshape.svg" alt="" className="size-4 shrink-0 rounded-sm object-contain" />
            <h3 className="truncate text-sm font-medium text-foreground">
              {connection.displayName}
            </h3>
            {connection.secretKeyConfigured ? (
              <span className="rounded-md border border-success/30 bg-success/10 px-1 py-0.5 text-[10px] text-success">
                API key saved
              </span>
            ) : null}
          </div>
          <p className="truncate text-xs text-muted-foreground" title={connection.baseUrl}>
            {connection.baseUrl}
          </p>
          <p className="truncate text-[11px] text-muted-foreground/70">
            Access key {connection.accessKeyId}
          </p>
        </div>
        <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
          <Button
            size="xs"
            variant="outline"
            disabled={isDeleting}
            onClick={() => onEdit(connection)}
          >
            Update key
          </Button>
          <Button
            size="xs"
            variant="destructive-outline"
            disabled={isDeleting}
            onClick={() => onDelete(connection)}
          >
            {isDeleting ? "Deleting..." : "Delete"}
          </Button>
        </div>
      </div>
    </div>
  );
}

type MechbaseConnectionListRowProps = {
  connection: MechbaseConnection;
  onEdit: () => void;
  onDelete: () => void;
  isDeleting: boolean;
};

function MechbaseConnectionListRow({
  connection,
  onEdit,
  onDelete,
  isDeleting,
}: MechbaseConnectionListRowProps) {
  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-2">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-lg border border-primary/25 bg-primary/10 text-primary">
              <BotIcon className="size-3.5" />
            </span>
            <h3 className="truncate text-sm font-medium text-foreground">
              {connection.displayName}
            </h3>
            {connection.apiKeyConfigured ? (
              <span className="rounded-md border border-success/30 bg-success/10 px-1 py-0.5 text-[10px] text-success">
                API key saved
              </span>
            ) : null}
          </div>
          <p className="truncate text-xs text-muted-foreground">
            Mechbase connector credentials are stored in the local backend secret store.
          </p>
        </div>
        <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
          <Button size="xs" variant="outline" disabled={isDeleting} onClick={onEdit}>
            Update key
          </Button>
          <Button size="xs" variant="destructive-outline" disabled={isDeleting} onClick={onDelete}>
            {isDeleting ? "Deleting..." : "Delete"}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function ConnectionsSettings() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();

  const [onshapeConnections, setOnshapeConnections] = useState<ReadonlyArray<OnshapeConnection>>(
    [],
  );
  const [isLoadingOnshapeConnections, setIsLoadingOnshapeConnections] = useState(false);
  const [onshapeConnectionDialogOpen, setOnshapeConnectionDialogOpen] = useState(false);
  const [onshapeEditingConnection, setOnshapeEditingConnection] =
    useState<OnshapeConnection | null>(null);
  const [onshapeDisplayName, setOnshapeDisplayName] = useState("");
  const [onshapeBaseUrl, setOnshapeBaseUrl] = useState("https://cad.onshape.com");
  const [onshapeAccessKeyId, setOnshapeAccessKeyId] = useState("");
  const [onshapeSecretKey, setOnshapeSecretKey] = useState("");
  const [onshapeConnectionError, setOnshapeConnectionError] = useState<string | null>(null);
  const [isSavingOnshapeConnection, setIsSavingOnshapeConnection] = useState(false);
  const [deletingOnshapeConnectionId, setDeletingOnshapeConnectionId] = useState<string | null>(
    null,
  );

  const [mechbaseConnections, setMechbaseConnections] = useState<ReadonlyArray<MechbaseConnection>>(
    [],
  );
  const [isLoadingMechbaseConnections, setIsLoadingMechbaseConnections] = useState(false);
  const [mechbaseConnectionDialogOpen, setMechbaseConnectionDialogOpen] = useState(false);
  const [mechbaseApiKey, setMechbaseApiKey] = useState("");
  const [mechbaseConnectionError, setMechbaseConnectionError] = useState<string | null>(null);
  const [isSavingMechbaseConnection, setIsSavingMechbaseConnection] = useState(false);
  const [isDeletingMechbaseConnection, setIsDeletingMechbaseConnection] = useState(false);

  const resetOnshapeConnectionForm = useCallback(() => {
    setOnshapeEditingConnection(null);
    setOnshapeConnectionError(null);
    setOnshapeDisplayName("");
    setOnshapeBaseUrl("https://cad.onshape.com");
    setOnshapeAccessKeyId("");
    setOnshapeSecretKey("");
  }, []);

  const loadOnshapeConnections = useCallback(async () => {
    if (primaryEnvironmentId === null) {
      setOnshapeConnectionError("Primary environment is not available.");
      setOnshapeConnections([]);
      return;
    }

    const api = readEnvironmentApi(primaryEnvironmentId);
    if (!api) {
      setOnshapeConnectionError("Primary environment API is not available.");
      setOnshapeConnections([]);
      return;
    }

    setIsLoadingOnshapeConnections(true);
    setOnshapeConnectionError(null);
    try {
      const result = await api.onshape.listConnections();
      setOnshapeConnections(result.connections);
    } catch (error) {
      setOnshapeConnectionError(
        error instanceof Error ? error.message : "Failed to load Onshape connections.",
      );
    } finally {
      setIsLoadingOnshapeConnections(false);
    }
  }, [primaryEnvironmentId]);

  const handleOpenOnshapeConnectionDialog = useCallback(
    (connection: OnshapeConnection | null = null) => {
      setOnshapeEditingConnection(connection);
      setOnshapeConnectionError(null);
      setOnshapeDisplayName(connection?.displayName ?? "");
      setOnshapeBaseUrl(connection?.baseUrl ?? "https://cad.onshape.com");
      setOnshapeAccessKeyId(connection?.accessKeyId ?? "");
      setOnshapeSecretKey("");
      setOnshapeConnectionDialogOpen(true);
    },
    [],
  );

  const handleSaveOnshapeConnection = useCallback(async () => {
    const displayName = onshapeDisplayName.trim();
    const baseUrl = onshapeBaseUrl.trim();
    const accessKeyId = onshapeAccessKeyId.trim();
    const secretKey = onshapeSecretKey.trim();

    if (!displayName || !baseUrl || !accessKeyId || !secretKey) {
      setOnshapeConnectionError("Enter a display name, base URL, access key id, and secret key.");
      return;
    }
    if (primaryEnvironmentId === null) {
      setOnshapeConnectionError("Primary environment is not available.");
      return;
    }

    const api = readEnvironmentApi(primaryEnvironmentId);
    if (!api) {
      setOnshapeConnectionError("Primary environment API is not available.");
      return;
    }

    setIsSavingOnshapeConnection(true);
    setOnshapeConnectionError(null);
    try {
      const result = await api.onshape.setupConnection({
        displayName,
        baseUrl,
        accessKeyId,
        secretKey,
      });
      setOnshapeConnections((connections) => {
        const existingIndex = connections.findIndex(
          (connection) => connection.connectionId === result.connection.connectionId,
        );
        if (existingIndex === -1) {
          return [...connections, result.connection].toSorted((left, right) =>
            left.displayName.localeCompare(right.displayName),
          );
        }
        const updated = [...connections];
        updated[existingIndex] = result.connection;
        return updated.toSorted((left, right) => left.displayName.localeCompare(right.displayName));
      });
      setOnshapeConnectionDialogOpen(false);
      resetOnshapeConnectionForm();
      toastManager.add({
        type: "success",
        title: onshapeEditingConnection ? "Onshape key updated" : "Onshape connected",
        description: `${result.connection.displayName} is ready for Onshape workspace imports.`,
      });
    } catch (error) {
      setOnshapeConnectionError(
        error instanceof Error ? error.message : "Failed to save Onshape connection.",
      );
    } finally {
      setIsSavingOnshapeConnection(false);
    }
  }, [
    onshapeAccessKeyId,
    onshapeBaseUrl,
    onshapeDisplayName,
    onshapeEditingConnection,
    onshapeSecretKey,
    primaryEnvironmentId,
    resetOnshapeConnectionForm,
  ]);

  const handleDeleteOnshapeConnection = useCallback(
    async (connection: OnshapeConnection) => {
      if (primaryEnvironmentId === null) {
        setOnshapeConnectionError("Primary environment is not available.");
        return;
      }

      const api = readEnvironmentApi(primaryEnvironmentId);
      if (!api) {
        setOnshapeConnectionError("Primary environment API is not available.");
        return;
      }

      setDeletingOnshapeConnectionId(connection.connectionId);
      setOnshapeConnectionError(null);
      try {
        await api.onshape.removeConnection({ connectionId: connection.connectionId });
        setOnshapeConnections((connections) =>
          connections.filter((item) => item.connectionId !== connection.connectionId),
        );
        toastManager.add({
          type: "success",
          title: "Onshape connection deleted",
          description: `${connection.displayName} was removed.`,
        });
      } catch (error) {
        setOnshapeConnectionError(
          error instanceof Error ? error.message : "Failed to delete Onshape connection.",
        );
      } finally {
        setDeletingOnshapeConnectionId(null);
      }
    },
    [primaryEnvironmentId],
  );

  const resetMechbaseConnectionForm = useCallback(() => {
    setMechbaseConnectionError(null);
    setMechbaseApiKey("");
  }, []);

  const loadMechbaseConnections = useCallback(async () => {
    if (primaryEnvironmentId === null) {
      setMechbaseConnectionError("Primary environment is not available.");
      setMechbaseConnections([]);
      return;
    }

    const api = readEnvironmentApi(primaryEnvironmentId);
    if (!api) {
      setMechbaseConnectionError("Primary environment API is not available.");
      setMechbaseConnections([]);
      return;
    }

    setIsLoadingMechbaseConnections(true);
    setMechbaseConnectionError(null);
    try {
      const result = await api.mechbase.listConnections();
      setMechbaseConnections(result.connections);
    } catch (error) {
      setMechbaseConnections([]);
      setMechbaseConnectionError(
        error instanceof Error ? error.message : "Failed to load Mechbase connections.",
      );
    } finally {
      setIsLoadingMechbaseConnections(false);
    }
  }, [primaryEnvironmentId]);

  const handleOpenMechbaseConnectionDialog = useCallback(() => {
    setMechbaseConnectionError(null);
    setMechbaseApiKey("");
    setMechbaseConnectionDialogOpen(true);
  }, []);

  const handleSaveMechbaseConnection = useCallback(async () => {
    const apiKey = mechbaseApiKey.trim();
    if (!apiKey) {
      setMechbaseConnectionError("Enter a Mechbase API key.");
      return;
    }
    if (primaryEnvironmentId === null) {
      setMechbaseConnectionError("Primary environment is not available.");
      return;
    }

    const api = readEnvironmentApi(primaryEnvironmentId);
    if (!api) {
      setMechbaseConnectionError("Primary environment API is not available.");
      return;
    }

    setIsSavingMechbaseConnection(true);
    setMechbaseConnectionError(null);
    try {
      const result = await api.mechbase.setupConnection({ apiKey });
      setMechbaseConnections([result.connection]);
      setMechbaseConnectionDialogOpen(false);
      resetMechbaseConnectionForm();
      toastManager.add({
        type: "success",
        title: "Mechbase connected",
        description: "Mechbase is ready to use.",
      });
    } catch (error) {
      setMechbaseConnectionError(
        error instanceof Error ? error.message : "Failed to save Mechbase connection.",
      );
    } finally {
      setIsSavingMechbaseConnection(false);
    }
  }, [mechbaseApiKey, primaryEnvironmentId, resetMechbaseConnectionForm]);

  const handleDeleteMechbaseConnection = useCallback(async () => {
    if (primaryEnvironmentId === null) {
      setMechbaseConnectionError("Primary environment is not available.");
      return;
    }

    const api = readEnvironmentApi(primaryEnvironmentId);
    if (!api) {
      setMechbaseConnectionError("Primary environment API is not available.");
      return;
    }

    setIsDeletingMechbaseConnection(true);
    setMechbaseConnectionError(null);
    try {
      await api.mechbase.removeConnection();
      setMechbaseConnections([]);
      toastManager.add({
        type: "success",
        title: "Mechbase connection deleted",
        description: "The Mechbase API key was removed.",
      });
    } catch (error) {
      setMechbaseConnectionError(
        error instanceof Error ? error.message : "Failed to delete Mechbase connection.",
      );
    } finally {
      setIsDeletingMechbaseConnection(false);
    }
  }, [primaryEnvironmentId]);

  useEffect(() => {
    void loadOnshapeConnections();
  }, [loadOnshapeConnections]);

  useEffect(() => {
    void loadMechbaseConnections();
  }, [loadMechbaseConnections]);

  return (
    <SettingsPageContainer>
      <SettingsSection
        title={
          <span className="inline-flex items-center gap-1">
            <span>Onshape</span>
            <ConnectionInfoDialog
              title="Onshape"
              description="Connect your Onshape account so Cadsense can inspect CAD documents during reviews."
              steps={[
                "Sign in to Onshape.",
                "Click your profile icon in the top-right corner.",
                "Open My Account.",
                "Go to Developer.",
                "Create a new API key.",
                "Copy both the API key and the secret.",
                "Paste both values into Cadsense.",
              ]}
              links={[
                {
                  label: "Open Onshape",
                  href: "https://cad.onshape.com/",
                },
                {
                  label: "API key docs",
                  href: "https://cad.onshape.com/help/Content/Plans/my_account_developer.htm",
                },
              ]}
            />
          </span>
        }
        headerAction={
          <div className="flex items-center gap-1">
            <Button
              size="xs"
              variant="ghost"
              className={HEADER_ACTION_BUTTON_CLASSNAME}
              disabled={isLoadingOnshapeConnections}
              onClick={() => void loadOnshapeConnections()}
            >
              {isLoadingOnshapeConnections ? (
                <RefreshCwIcon className="size-3 animate-spin" />
              ) : (
                <RefreshCwIcon className="size-3" />
              )}
              Refresh
            </Button>
            <Dialog
              open={onshapeConnectionDialogOpen}
              onOpenChange={(open) => {
                if (isSavingOnshapeConnection) return;
                setOnshapeConnectionDialogOpen(open);
                if (!open) resetOnshapeConnectionForm();
              }}
            >
              {onshapeConnections.length === 0 ? (
                <DialogTrigger
                  render={
                    <Button
                      size="xs"
                      variant="ghost"
                      className={HEADER_ACTION_BUTTON_CLASSNAME}
                      aria-label="Add Onshape connection"
                    >
                      <PlusIcon className="size-3" />
                      <span>Add connection</span>
                    </Button>
                  }
                />
              ) : null}
              <DialogPopup className="max-w-md">
                <DialogHeader>
                  <DialogTitle>
                    {onshapeEditingConnection ? "Update Onshape API key" : "Add Onshape connection"}
                  </DialogTitle>
                  <DialogDescription>
                    API secrets are stored in the local backend secret store. Only redacted
                    connection metadata is shown in the app.
                  </DialogDescription>
                </DialogHeader>
                <DialogPanel className="space-y-4">
                  <label className="block">
                    <span className="mb-1.5 block text-xs font-medium text-foreground">
                      Display name
                    </span>
                    <Input
                      value={onshapeDisplayName}
                      onChange={(event) => setOnshapeDisplayName(event.target.value)}
                      placeholder="Onshape"
                      disabled={isSavingOnshapeConnection}
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1.5 block text-xs font-medium text-foreground">
                      Base URL
                    </span>
                    <Input
                      value={onshapeBaseUrl}
                      onChange={(event) => setOnshapeBaseUrl(event.target.value)}
                      placeholder="https://cad.onshape.com"
                      disabled={isSavingOnshapeConnection}
                      spellCheck={false}
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1.5 block text-xs font-medium text-foreground">
                      Access key id
                    </span>
                    <Input
                      value={onshapeAccessKeyId}
                      onChange={(event) => setOnshapeAccessKeyId(event.target.value)}
                      disabled={isSavingOnshapeConnection}
                      spellCheck={false}
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1.5 block text-xs font-medium text-foreground">
                      Secret key
                    </span>
                    <Input
                      type="password"
                      value={onshapeSecretKey}
                      onChange={(event) => setOnshapeSecretKey(event.target.value)}
                      placeholder={
                        onshapeEditingConnection
                          ? "Enter a new secret key"
                          : "Onshape API secret key"
                      }
                      disabled={isSavingOnshapeConnection}
                      spellCheck={false}
                    />
                  </label>
                  {onshapeConnectionError ? (
                    <p className="text-xs text-destructive">{onshapeConnectionError}</p>
                  ) : null}
                </DialogPanel>
                <DialogFooter>
                  <DialogClose
                    disabled={isSavingOnshapeConnection}
                    render={<Button variant="outline" disabled={isSavingOnshapeConnection} />}
                  >
                    Cancel
                  </DialogClose>
                  <Button
                    disabled={isSavingOnshapeConnection}
                    onClick={() => void handleSaveOnshapeConnection()}
                  >
                    {isSavingOnshapeConnection ? (
                      <>
                        <Spinner className="size-3.5" />
                        Saving...
                      </>
                    ) : onshapeEditingConnection ? (
                      "Update key"
                    ) : (
                      "Add connection"
                    )}
                  </Button>
                </DialogFooter>
              </DialogPopup>
            </Dialog>
          </div>
        }
      >
        {onshapeConnectionError && !onshapeConnectionDialogOpen ? (
          <div className={ITEM_ROW_CLASSNAME}>
            <p className="text-xs text-destructive">{onshapeConnectionError}</p>
          </div>
        ) : null}
        {onshapeConnections.map((connection) => (
          <OnshapeConnectionListRow
            key={connection.connectionId}
            connection={connection}
            onEdit={handleOpenOnshapeConnectionDialog}
            onDelete={(connection) => void handleDeleteOnshapeConnection(connection)}
            isDeleting={deletingOnshapeConnectionId === connection.connectionId}
          />
        ))}
        {onshapeConnections.length === 0 && !isLoadingOnshapeConnections ? (
          <div className={ITEM_ROW_CLASSNAME}>
            <p className="text-xs text-muted-foreground">
              No Onshape API keys configured. Add a connection here, then import Onshape document
              URLs from the project picker.
            </p>
          </div>
        ) : null}
        {onshapeConnections.length === 0 && isLoadingOnshapeConnections ? (
          <div className={ITEM_ROW_CLASSNAME}>
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Spinner className="size-3.5" />
              Loading Onshape connections...
            </p>
          </div>
        ) : null}
      </SettingsSection>

      <SettingsSection
        title={
          <span className="inline-flex items-center gap-1">
            <span>Mechbase</span>
            <ConnectionInfoDialog
              title="Mechbase"
              description="A RAG platform that unifies technical documents, robot photos, CAD models, and team knowledge into a searchable engineering knowledge base built for FIRST Robotics teams. Use this to ground CAD reviews in real examples, past robot designs, manufacturing notes, mechanism references, and team-specific precedent instead of relying only on generic design advice."
              steps={[
                "Sign in to Mechbase.",
                "Create an API key.",
                "Paste the API key into Cadsense.",
              ]}
              links={[
                {
                  label: "Open Mechbase",
                  href: "https://mechbase.johari-dev.com/",
                },
              ]}
            />
          </span>
        }
        headerAction={
          <div className="flex items-center gap-1">
            <Button
              size="xs"
              variant="ghost"
              className={HEADER_ACTION_BUTTON_CLASSNAME}
              disabled={isLoadingMechbaseConnections}
              onClick={() => void loadMechbaseConnections()}
            >
              {isLoadingMechbaseConnections ? (
                <RefreshCwIcon className="size-3 animate-spin" />
              ) : (
                <RefreshCwIcon className="size-3" />
              )}
              Refresh
            </Button>
            <Dialog
              open={mechbaseConnectionDialogOpen}
              onOpenChange={(open) => {
                if (isSavingMechbaseConnection) return;
                setMechbaseConnectionDialogOpen(open);
                if (!open) resetMechbaseConnectionForm();
              }}
            >
              {mechbaseConnections.length === 0 ? (
                <DialogTrigger
                  render={
                    <Button
                      size="xs"
                      variant="ghost"
                      className={HEADER_ACTION_BUTTON_CLASSNAME}
                      aria-label="Add Mechbase connection"
                    >
                      <PlusIcon className="size-3" />
                      <span>Add connection</span>
                    </Button>
                  }
                />
              ) : null}
              <DialogPopup className="max-w-md">
                <DialogHeader>
                  <DialogTitle>
                    {mechbaseConnections.length > 0
                      ? "Update Mechbase API key"
                      : "Add Mechbase connection"}
                  </DialogTitle>
                  <DialogDescription>
                    API keys are stored in the local backend secret store. Only connection status is
                    shown in the app. Get a Mechbase API key from{" "}
                    <a
                      href="https://mechbase.johari-dev.com/"
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium text-foreground underline underline-offset-2"
                    >
                      mechbase.johari-dev.com
                    </a>
                    .
                  </DialogDescription>
                </DialogHeader>
                <DialogPanel className="space-y-4">
                  <label className="block">
                    <span className="mb-1.5 block text-xs font-medium text-foreground">
                      API key
                    </span>
                    <Input
                      type="password"
                      value={mechbaseApiKey}
                      onChange={(event) => setMechbaseApiKey(event.target.value)}
                      placeholder="Mechbase API key"
                      disabled={isSavingMechbaseConnection}
                      spellCheck={false}
                    />
                  </label>
                  {mechbaseConnectionError ? (
                    <p className="text-xs text-destructive">{mechbaseConnectionError}</p>
                  ) : null}
                </DialogPanel>
                <DialogFooter>
                  <DialogClose
                    disabled={isSavingMechbaseConnection}
                    render={<Button variant="outline" disabled={isSavingMechbaseConnection} />}
                  >
                    Cancel
                  </DialogClose>
                  <Button
                    disabled={isSavingMechbaseConnection}
                    onClick={() => void handleSaveMechbaseConnection()}
                  >
                    {isSavingMechbaseConnection ? (
                      <>
                        <Spinner className="size-3.5" />
                        Saving...
                      </>
                    ) : mechbaseConnections.length > 0 ? (
                      "Update key"
                    ) : (
                      "Add connection"
                    )}
                  </Button>
                </DialogFooter>
              </DialogPopup>
            </Dialog>
          </div>
        }
      >
        {mechbaseConnectionError && !mechbaseConnectionDialogOpen ? (
          <div className={ITEM_ROW_CLASSNAME}>
            <p className="text-xs text-destructive">{mechbaseConnectionError}</p>
          </div>
        ) : null}
        {mechbaseConnections.map((connection) => (
          <MechbaseConnectionListRow
            key={connection.displayName}
            connection={connection}
            onEdit={handleOpenMechbaseConnectionDialog}
            onDelete={() => void handleDeleteMechbaseConnection()}
            isDeleting={isDeletingMechbaseConnection}
          />
        ))}
        {mechbaseConnections.length === 0 && !isLoadingMechbaseConnections ? (
          <div className={ITEM_ROW_CLASSNAME}>
            <p className="text-xs text-muted-foreground">
              No Mechbase API key configured. Add a connection here to enable the Mechbase
              connector.
            </p>
          </div>
        ) : null}
        {mechbaseConnections.length === 0 && isLoadingMechbaseConnections ? (
          <div className={ITEM_ROW_CLASSNAME}>
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Spinner className="size-3.5" />
              Loading Mechbase connection...
            </p>
          </div>
        ) : null}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
