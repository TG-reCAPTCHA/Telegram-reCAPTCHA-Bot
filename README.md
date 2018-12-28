# Telegram-reCAPTCHA-Bot  

🚷 A simple bot used for protecting Telegram groups from SPAM, powered by reCAPTCHA while protecting privacy.  

# Get start  
> This bot is only designed for AWS Lambda now.  

1. Create a Lambda APP, bind API Gateway for it  
2. Set all environment variables in Lambda console. (ENV Keys are available in .env example)  
3. Install this project in local and upload `node_modules` and `index.js` to Lambda  
4. Set webhook URL for you bot in Telegram Bot API
5. Add bot into your supergroup and give it Ban users permission  

You can also directly add [@reCAPTCHAxtooooon_Bot](https://t.me/reCAPTCHAxtooooon_Bot) into your group, this is a demo instance.
  
# Do this bot's verification page collect my privacy?

We consider user privacy in every byte and use lots of methods to prevent privacy issue, such as use Github Page for verification, pass verification information via URL hash to avoid server interaction with unnecessary data.  

So feel relax, no one can associate your identity because every part of this service can only get limited information.

# About  
MIT License, made by lwl12 with interests.