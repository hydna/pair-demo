behavior("/pair/{id}", {
    open: function (event) {
        if (event.write) {
            event.channel.get("busy", function (err, val) {
                if ((err && err !== "not found") || val == "yes") {
                    event.deny(err || "busy");
                    return;
                }
                event.channel.set("busy", "yes", function (err) {
                    if (err) {
                        event.deny(err || "busy");
                        return;
                    }
                    event.allow();
                });
            });
        } else {
            event.channel.emit("connected");
        }
    },
    close: function (event) {
        if (event.write) {
            event.channel.del("busy");
        }
        event.channel.emit("disconnected");
    }
});
