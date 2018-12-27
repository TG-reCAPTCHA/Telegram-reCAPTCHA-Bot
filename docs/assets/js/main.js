const [jwt, gname, uid, gid, botname, g_sitekey] = location.hash.replace("#", "").split(";");
$(".gname").text(decodeURI(gname));
$(".uid").text(decodeURI(uid));
$(".gid").text(decodeURI(gid));
$(".botname").text(decodeURI(botname));
$(".botname").attr("href", "https://t.me/" + decodeURI(botname));

var verifyCallback = function (response) {

    const payload = JSON.stringify({
        "jwt": jwt,
        "gresponse": response
    });

    const callback = function (data) {
        const id = data["key"];
        if (id){
            window.location.href = "https://t.me/" + botname + "?start=" + id;
        }
        document.getElementById("recaptcha-response").innerText = "/verify " + btoa(payload);
        document.getElementById("guideForManual").style.display = '';
    };

    $.ajax("https://bytebin.lucko.me/post", {
        contentType: "application/json; charset=utf-8",
        dataType: "json",
        data: payload,
        method: "POST",
        success: callback
    });
}

var onloadCallback = function() {
    grecaptcha.render('g-recaptcha', {
      'sitekey' : g_sitekey,
      'callback' : verifyCallback
    });
  };