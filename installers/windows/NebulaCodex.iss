; Instalador de NebulaCodex para Windows (Inno Setup 6).
; Se compila desde scripts/package.mjs:
;   ISCC /DAppVersion=0.1.0 /DPayloadDir=... /DIconFile=... /DLicenseFile=... /DOutputDir=... /DOutputBase=... NebulaCodex.iss

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef OutputBase
  #define OutputBase "NebulaCodex-setup"
#endif
#define AppName "NebulaCodex"
#define AppPublisher "Tpskevin13"
#define AppURL "https://github.com/Tpskevin13/NebulaCodex"

[Setup]
AppId={{B3E5C0D2-6F0A-4C57-9B7E-2D4A1F8E7C31}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
AppSupportURL={#AppURL}/issues
AppUpdatesURL={#AppURL}/releases
VersionInfoVersion={#AppVersion}
DefaultDirName={autopf}\{#AppName}
DisableProgramGroupPage=yes
DisableDirPage=auto
PrivilegesRequired=lowest
OutputDir={#OutputDir}
OutputBaseFilename={#OutputBase}
SetupIconFile={#IconFile}
UninstallDisplayIcon={app}\nebulacodex.ico
LicenseFile={#LicenseFile}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
ChangesEnvironment=yes
CloseApplications=no

[Languages]
Name: "spanish"; MessagesFile: "compiler:Languages\Spanish.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[CustomMessages]
spanish.AddToPath=Agregar NebulaCodex al PATH (para escribir "nebulacodex" en cualquier terminal)
english.AddToPath=Add NebulaCodex to the PATH (to type "nebulacodex" in any terminal)
spanish.DeleteConfig=¿Querés borrar también tu configuración, API keys y chats guardados?%n%n(%1)
english.DeleteConfig=Do you also want to delete your settings, API keys and saved chats?%n%n(%1)

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"
Name: "addtopath"; Description: "{cm:AddToPath}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "{#PayloadDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "{#IconFile}"; DestDir: "{app}"; DestName: "nebulacodex.ico"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\bin\nebulacodex.cmd"; WorkingDir: "{%USERPROFILE}"; IconFilename: "{app}\nebulacodex.ico"; Comment: "Agente de código libre para la terminal"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\bin\nebulacodex.cmd"; WorkingDir: "{%USERPROFILE}"; IconFilename: "{app}\nebulacodex.ico"; Comment: "Agente de código libre para la terminal"; Tasks: desktopicon

[Run]
Filename: "{app}\bin\nebulacodex.cmd"; Description: "{cm:LaunchProgram,{#AppName}}"; WorkingDir: "{%USERPROFILE}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: "{app}"

[Code]
const
  EnvKey = 'Environment';

function NormalizeDir(Dir: string): string;
begin
  Result := Dir;
  while (Length(Result) > 3) and (Result[Length(Result)] = '\') do
    Delete(Result, Length(Result), 1);
end;

procedure AddToUserPath(Dir: string);
var
  Paths, Rest, Item: string;
  P: Integer;
begin
  if not RegQueryStringValue(HKCU, EnvKey, 'Path', Paths) then
    Paths := '';
  Rest := Paths;
  while Rest <> '' do
  begin
    P := Pos(';', Rest);
    if P = 0 then
    begin
      Item := Rest;
      Rest := '';
    end
    else
    begin
      Item := Copy(Rest, 1, P - 1);
      Delete(Rest, 1, P);
    end;
    if CompareText(NormalizeDir(Item), NormalizeDir(Dir)) = 0 then
      Exit; { ya estaba }
  end;
  if (Paths <> '') and (Paths[Length(Paths)] <> ';') then
    Paths := Paths + ';';
  RegWriteExpandStringValue(HKCU, EnvKey, 'Path', Paths + Dir);
end;

procedure RemoveFromUserPath(Dir: string);
var
  Paths, NewPaths, Item: string;
  P: Integer;
begin
  if not RegQueryStringValue(HKCU, EnvKey, 'Path', Paths) then
    Exit;
  NewPaths := '';
  while Paths <> '' do
  begin
    P := Pos(';', Paths);
    if P = 0 then
    begin
      Item := Paths;
      Paths := '';
    end
    else
    begin
      Item := Copy(Paths, 1, P - 1);
      Delete(Paths, 1, P);
    end;
    if (Item <> '') and (CompareText(NormalizeDir(Item), NormalizeDir(Dir)) <> 0) then
    begin
      if NewPaths <> '' then
        NewPaths := NewPaths + ';';
      NewPaths := NewPaths + Item;
    end;
  end;
  RegWriteExpandStringValue(HKCU, EnvKey, 'Path', NewPaths);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if (CurStep = ssPostInstall) and WizardIsTaskSelected('addtopath') then
    AddToUserPath(ExpandConstant('{app}\bin'));
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  ConfigDir: string;
begin
  if CurUninstallStep = usPostUninstall then
  begin
    RemoveFromUserPath(ExpandConstant('{app}\bin'));
    ConfigDir := ExpandConstant('{%USERPROFILE}\.nebulacodex');
    if (not UninstallSilent) and DirExists(ConfigDir) then
      if MsgBox(FmtMessage(CustomMessage('DeleteConfig'), [ConfigDir]), mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
        DelTree(ConfigDir, True, True, True);
  end;
end;
