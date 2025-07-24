let pollInterval = null;

function startPolling(key,url) {
  pollInterval = setInterval(async () => {
    try {
      const response = await fetch("url", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ key })
      });

      const data = await response.json();

      if (data?.Item?.imageVerified !== "Pending" && data?.Item?.audioVerified !== "Pending") {
        console.log("Verification complete:", data.Item);

        clearInterval(pollInterval);
      }
    } catch (err) {
      console.error("Error polling verification:", err);
    }
  }, 3000); 
}
