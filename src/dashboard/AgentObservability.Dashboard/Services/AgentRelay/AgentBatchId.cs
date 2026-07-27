using System.Globalization;
using System.Text.RegularExpressions;

namespace AgentObservability.Dashboard.Services.AgentRelay;

/// <summary>
/// Mints and validates the opaque, URL-safe batch ids used by the relay. The format is
/// <c>{createdAtMs:D13}-{guidN}</c>: the zero-padded ingest millisecond makes the id time-sortable
/// (so blob names sort chronologically) and the GUID guarantees uniqueness within the same
/// millisecond. Validation constrains the id to <c>[0-9A-Za-z_-]</c> so it can never encode a path
/// separator or traversal sequence when composed into a blob path.
/// </summary>
public static partial class AgentBatchId
{
    public static string Mint(long createdAtMs) =>
        string.Create(
            CultureInfo.InvariantCulture,
            $"{Math.Max(0, createdAtMs):D13}-{Guid.NewGuid():N}");

    public static bool IsValid(string? id) => !string.IsNullOrEmpty(id) && ValidPattern().IsMatch(id);

    [GeneratedRegex("^[0-9A-Za-z_-]{1,200}$")]
    private static partial Regex ValidPattern();
}
