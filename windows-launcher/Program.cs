using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

var appDirectory = AppContext.BaseDirectory;
var scriptPath = Path.Combine(appDirectory, "iniciar.ps1");

if (!File.Exists(scriptPath))
{
    ShowError($"No se encontró el iniciador PowerShell: {scriptPath}");
    return 1;
}

var startInfo = new ProcessStartInfo
{
    FileName = "powershell.exe",
    WorkingDirectory = appDirectory,
    UseShellExecute = true,
    WindowStyle = ProcessWindowStyle.Normal,
};

var powershellArguments = new List<string>
{
    "-NoLogo",
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", scriptPath,
};
powershellArguments.AddRange(args);
startInfo.Arguments = string.Join(" ", powershellArguments.Select(QuoteArgument));

try
{
    using var process = Process.Start(startInfo);
    if (process is null)
    {
        ShowError("No se pudo iniciar PowerShell.");
        return 1;
    }

    process.WaitForExit();
    return process.ExitCode;
}
catch (Exception error)
{
    ShowError($"No se pudo abrir NebulaCodex: {error.Message}");
    return 1;
}

static string QuoteArgument(string argument)
{
    if (argument.Length > 0 && !argument.Any(char.IsWhiteSpace) && !argument.Contains('"'))
        return argument;

    var quoted = new StringBuilder("\"");
    var backslashes = 0;
    foreach (var character in argument)
    {
        if (character == '\\')
        {
            backslashes++;
            continue;
        }

        if (character == '"')
        {
            quoted.Append('\\', backslashes * 2 + 1).Append('"');
            backslashes = 0;
            continue;
        }

        quoted.Append('\\', backslashes).Append(character);
        backslashes = 0;
    }

    quoted.Append('\\', backslashes * 2).Append('"');
    return quoted.ToString();
}

static void ShowError(string message) => MessageBox(IntPtr.Zero, message, "NebulaCodex", 0x10);

[DllImport("user32.dll", CharSet = CharSet.Unicode)]
static extern int MessageBox(IntPtr window, string text, string caption, uint type);
