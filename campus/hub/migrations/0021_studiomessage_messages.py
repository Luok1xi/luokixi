from django.db import migrations, models

class Migration(migrations.Migration):
    dependencies = [('hub', '0020_studiomessage_expression')]
    operations = [migrations.AddField(model_name='studiomessage',name='messages',field=models.JSONField(default=list))]
